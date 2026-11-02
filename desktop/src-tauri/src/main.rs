mod data_directory;
mod environment;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[cfg(debug_assertions)]
use std::{
    path::PathBuf,
    process::{Child, Command},
};

#[cfg(not(debug_assertions))]
use tauri::async_runtime::Receiver;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

enum SidecarChild {
    #[cfg(debug_assertions)]
    Debug(Child),
    #[cfg(not(debug_assertions))]
    Bundled {
        child: CommandChild,
        events: Receiver<CommandEvent>,
    },
}

impl SidecarChild {
    fn terminate(self) {
        match self {
            #[cfg(debug_assertions)]
            Self::Debug(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(not(debug_assertions))]
            Self::Bundled { child, mut events } => {
                let _ = child.kill();
                // The shell child handle consumes itself on kill.  Drain its
                // event channel until the actual process termination arrives,
                // with a bounded fallback so application exit cannot hang.
                for _ in 0..100 {
                    match events.try_recv() {
                        Ok(CommandEvent::Terminated(_)) => break,
                        Ok(_) => continue,
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                }
            }
        }
    }
}

struct SidecarState(Mutex<Option<SidecarChild>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    api_base: Option<String>,
    startup_error: Option<String>,
}

#[tauri::command]
fn desktop_runtime_config(state: tauri::State<'_, RuntimeConfig>) -> RuntimeConfig {
    state.inner().clone()
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法分配本地服务端口：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取本地服务端口：{error}"))
}

fn new_instance_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{timestamp}", std::process::id())
}

fn health_response_matches(response: &str, instance_id: &str) -> bool {
    if !response.starts_with("HTTP/1.1 200") {
        return false;
    }
    let body = response.split_once("\r\n\r\n").map(|(_, body)| body);
    let Some(Ok(value)) = body.map(serde_json::from_str::<serde_json::Value>) else {
        return false;
    };
    value["status"] == "ok"
        && value["service"] == "tuantuan"
        && value["version"] == env!("CARGO_PKG_VERSION")
        && value["instance_id"] == instance_id
}

fn health_matches(port: u16, instance_id: &str) -> bool {
    let address: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(address) => address,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(200)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    health_response_matches(&response, instance_id)
}

fn wait_for_sidecar(port: u16, instance_id: &str) -> Result<(), String> {
    for _ in 0..300 {
        if health_matches(port, instance_id) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("团团本地服务未能在 60 秒内完成启动".to_string())
}

#[cfg(debug_assertions)]
fn start_api(
    app: &tauri::AppHandle,
    port: u16,
    instance_id: &str,
) -> Result<SidecarChild, Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let python = environment::value("PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("backend/.venv/bin/python"));
    let entrypoint = root.join("backend/app/desktop_server.py");
    let data_dir = data_directory::discover(app.path().app_data_dir()?)?;
    std::fs::create_dir_all(&data_dir)?;
    let child = Command::new(python)
        .arg(entrypoint)
        .args(["--data-dir", data_dir.to_string_lossy().as_ref()])
        .args(["--port", &port.to_string()])
        .args(["--instance-id", instance_id])
        .spawn()?;
    Ok(SidecarChild::Debug(child))
}

#[cfg(not(debug_assertions))]
fn start_api(
    app: &tauri::AppHandle,
    port: u16,
    instance_id: &str,
) -> Result<SidecarChild, Box<dyn std::error::Error>> {
    let data_dir = data_directory::discover(app.path().app_data_dir()?)?;
    std::fs::create_dir_all(&data_dir)?;
    let (events, child) = app
        .shell()
        .sidecar("tuantuan-server")?
        .args([
            "--data-dir",
            data_dir.to_string_lossy().as_ref(),
            "--port",
            &port.to_string(),
            "--instance-id",
            instance_id,
        ])
        .spawn()?;
    Ok(SidecarChild::Bundled { child, events })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopApiResponse {
    status: u16,
    body: String,
    body_base64: Option<String>,
    content_type: Option<String>,
    retry_after: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStreamEvent {
    request_id: String,
    kind: String,
    status: Option<u16>,
    content_type: Option<String>,
    retry_after: Option<String>,
    chunk_base64: Option<String>,
    error: Option<String>,
}

fn emit_stream(app: &tauri::AppHandle, event: DesktopStreamEvent) {
    // A late or missing WebView listener still receives the full body below.
    let _ = app.emit("desktop-api-stream", event);
}

fn is_event_stream(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopFormField {
    name: String,
    value: Option<String>,
    filename: Option<String>,
    content_type: Option<String>,
    data_base64: Option<String>,
}

fn multipart_header_value(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\r' | '\n' | '"' | '\\' => '_',
            _ => character,
        })
        .collect()
}

fn encode_multipart(fields: Vec<DesktopFormField>) -> Result<(String, Vec<u8>), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let boundary = format!("tuantuan-{}-{nonce}", std::process::id());
    let mut body = Vec::new();
    for field in fields {
        let name = multipart_header_value(&field.name);
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes(),
        );
        let content = match (field.value, field.data_base64) {
            (Some(value), None) => value.into_bytes(),
            (None, Some(encoded)) => {
                let filename = field.filename.ok_or("上传文件缺少文件名")?;
                let content_type = field
                    .content_type
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                body.extend_from_slice(
                    format!(
                        "; filename=\"{}\"\r\nContent-Type: {}",
                        multipart_header_value(&filename),
                        multipart_header_value(&content_type),
                    )
                    .as_bytes(),
                );
                BASE64
                    .decode(encoded)
                    .map_err(|_| "上传文件内容无效".to_string())?
            }
            _ => return Err("表单字段内容无效".to_string()),
        };
        body.extend_from_slice(b"\r\n\r\n");
        body.extend_from_slice(&content);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((boundary, body))
}

enum ApiTask {
    Running(Box<dyn FnOnce() + Send>),
    Cancelled(Instant),
}

#[derive(Default)]
struct ApiTasks(Mutex<HashMap<String, ApiTask>>);

impl ApiTasks {
    fn register(&self, id: String, abort: Box<dyn FnOnce() + Send>) -> bool {
        let mut tasks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        tasks.retain(|_, task| !matches!(task, ApiTask::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
        if tasks.contains_key(&id) {
            abort();
            return false;
        }
        tasks.insert(id, ApiTask::Running(abort));
        true
    }

    fn cancel(&self, id: String) {
        let mut tasks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match tasks.remove(&id) {
            Some(ApiTask::Running(abort)) => abort(),
            _ => {
                // IPC cancellation can arrive before the request registers.
                if tasks.len() < 1024 {
                    tasks.insert(id, ApiTask::Cancelled(Instant::now()));
                }
            }
        }
    }

    fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

#[tauri::command]
fn desktop_cancel_api_request(state: tauri::State<'_, ApiTasks>, request_id: String) {
    state.cancel(request_id);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopApiRequest {
    path: String,
    method: Option<String>,
    body: Option<String>,
    form_fields: Option<Vec<DesktopFormField>>,
    authorization: Option<String>,
    request_id: Option<String>,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn desktop_api_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeConfig>,
    tasks: tauri::State<'_, ApiTasks>,
    request: DesktopApiRequest,
) -> Result<DesktopApiResponse, String> {
    let base = match &state.api_base {
        Some(base) => base.clone(),
        None => {
            return Err(state
                .startup_error
                .clone()
                .unwrap_or_else(|| "本地服务地址不可用".to_string()))
        }
    };
    let id = request.request_id.clone().unwrap_or_else(new_instance_id);
    let handle = tauri::async_runtime::spawn(perform_api_request(app, base, id.clone(), request));
    let abort = handle.inner().abort_handle();
    if !tasks.register(id.clone(), Box::new(move || abort.abort())) {
        return Err("请求已取消或请求标识重复".to_string());
    }
    let result = handle.await.map_err(|_| "本地请求已取消".to_string());
    tasks.finish(&id);
    result?
}

async fn perform_api_request(
    app: tauri::AppHandle,
    base: String,
    request_id: String,
    request: DesktopApiRequest,
) -> Result<DesktopApiResponse, String> {
    if !request.path.starts_with('/') {
        return Err("请求路径必须以 / 开头".to_string());
    }
    let url = format!("{base}{}", request.path);
    let method = request
        .method
        .unwrap_or_else(|| "GET".to_string())
        .to_uppercase();
    // Sidecar is always on loopback. macOS system HTTP proxies (Clash etc.)
    // often return 502 for 127.0.0.1 even when ExceptionsList claims otherwise;
    // never route local API traffic through a proxy.
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_millis(
            request.timeout_ms.unwrap_or(30_000).clamp(1, 300_000),
        ))
        .build()
        .map_err(|error| format!("创建本地请求客户端失败：{error}"))?;
    let mut builder = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(authorization) = request.authorization {
        builder = builder.header("Authorization", authorization);
    }
    if let Some(fields) = request.form_fields {
        if request.body.is_some() {
            return Err("请求不能同时包含文本和表单内容".to_string());
        }
        let (boundary, body) = encode_multipart(fields)?;
        builder = builder
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body);
    } else if let Some(body) = request.body {
        builder = builder
            .header("Content-Type", "application/json")
            .body(body);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|error| format!("请求 {url} 失败：{error}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    if is_event_stream(content_type.as_deref()) {
        emit_stream(
            &app,
            DesktopStreamEvent {
                request_id: request_id.clone(),
                kind: "headers".into(),
                status: Some(status),
                content_type: content_type.clone(),
                retry_after: retry_after.clone(),
                chunk_base64: None,
                error: None,
            },
        );
        let mut collected = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if !chunk.is_empty() => {
                    collected.extend_from_slice(&chunk);
                    emit_stream(
                        &app,
                        DesktopStreamEvent {
                            request_id: request_id.clone(),
                            kind: "chunk".into(),
                            status: None,
                            content_type: None,
                            retry_after: None,
                            chunk_base64: Some(BASE64.encode(&chunk)),
                            error: None,
                        },
                    );
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(error) => {
                    let message = format!("读取 {url} 响应失败：{error}");
                    emit_stream(
                        &app,
                        DesktopStreamEvent {
                            request_id,
                            kind: "error".into(),
                            status: None,
                            content_type: None,
                            retry_after: None,
                            chunk_base64: None,
                            error: Some(message.clone()),
                        },
                    );
                    return Err(message);
                }
            }
        }
        emit_stream(
            &app,
            DesktopStreamEvent {
                request_id,
                kind: "end".into(),
                status: None,
                content_type: None,
                retry_after: None,
                chunk_base64: None,
                error: None,
            },
        );
        return Ok(DesktopApiResponse {
            status,
            body: String::from_utf8_lossy(&collected).into_owned(),
            body_base64: None,
            content_type,
            retry_after,
        });
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 {url} 响应失败：{error}"))?;
    let is_text = content_type.as_deref().is_some_and(|value| {
        value.starts_with("text/") || value.contains("json") || value.contains("xml")
    });
    let (body, body_base64) = if is_text {
        (String::from_utf8_lossy(&bytes).into_owned(), None)
    } else {
        (String::new(), Some(BASE64.encode(&bytes)))
    };
    Ok(DesktopApiResponse {
        status,
        body,
        body_base64,
        content_type,
        retry_after,
    })
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_config,
            desktop_api_request,
            desktop_cancel_api_request
        ])
        .setup(|app| {
            let port = reserve_loopback_port()?;
            let instance_id = new_instance_id();
            let api_base = format!("http://127.0.0.1:{port}");

            let (child, startup_error) = match start_api(&app.handle(), port, &instance_id) {
                Ok(child) => match wait_for_sidecar(port, &instance_id) {
                    Ok(()) => (Some(child), None),
                    Err(error) => {
                        child.terminate();
                        (None, Some(error))
                    }
                },
                Err(error) => (None, Some(format!("团团本地服务启动失败：{error}"))),
            };

            app.manage(RuntimeConfig {
                api_base: child.as_ref().map(|_| api_base),
                startup_error,
            });
            app.manage(SidecarState(Mutex::new(child)));
            app.manage(ApiTasks::default());
            app.get_webview_window("main")
                .ok_or("missing main window")?
                .show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building 团团 desktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<SidecarState>();
            if let Ok(mut child) = state.0.lock() {
                if let Some(child) = child.take() {
                    child.terminate();
                }
            };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{encode_multipart, health_response_matches, ApiTasks, DesktopFormField};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn request_cancellation_aborts_running_and_early_requests() {
        let tasks = ApiTasks::default();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        assert!(tasks.register(
            "active".into(),
            Box::new(move || {
                flag.store(true, Ordering::SeqCst);
            })
        ));
        tasks.cancel("active".into());
        assert!(cancelled.load(Ordering::SeqCst));
        tasks.cancel("early".into());
        let flag = cancelled.clone();
        cancelled.store(false, Ordering::SeqCst);
        assert!(!tasks.register(
            "early".into(),
            Box::new(move || {
                flag.store(true, Ordering::SeqCst);
            })
        ));
        assert!(cancelled.load(Ordering::SeqCst));
        tasks.finish("early");
        assert!(tasks.0.lock().unwrap().is_empty());
    }

    #[test]
    fn health_requires_matching_service_version_and_instance() {
        let response = format!(
            "HTTP/1.1 200 OK\r\n\r\n{}",
            serde_json::json!({ "status": "ok", "service": "tuantuan", "version": env!("CARGO_PKG_VERSION"), "instance_id": "test-instance" })
        );
        assert!(health_response_matches(&response, "test-instance"));
        assert!(!health_response_matches(&response, "other-instance"));
        assert!(!health_response_matches(
            &response.replace("tuantuan", "careerloop"),
            "test-instance"
        ));
        assert!(!health_response_matches(
            &response.replace(env!("CARGO_PKG_VERSION"), "99.0.0"),
            "test-instance"
        ));
        assert!(!health_response_matches(
            &response.replace("tuantuan", "other-service"),
            "test-instance"
        ));
        assert!(!health_response_matches(
            "HTTP/1.1 200 OK\r\n\r\n<html>loading</html>",
            "test-instance"
        ));
    }

    #[test]
    fn multipart_keeps_repeated_file_fields_and_binary_bytes() {
        let (boundary, body) = encode_multipart(vec![
            DesktopFormField {
                name: "mode".into(),
                value: Some("fast".into()),
                filename: None,
                content_type: None,
                data_base64: None,
            },
            DesktopFormField {
                name: "files".into(),
                value: None,
                filename: Some("笔记.txt".into()),
                content_type: Some("text/plain".into()),
                data_base64: Some("AAEC/w==".into()),
            },
        ])
        .expect("valid form");
        assert!(body.starts_with(format!("--{boundary}\r\n").as_bytes()));
        assert!(body.ends_with(format!("--{boundary}--\r\n").as_bytes()));
        assert!(body.windows(4).any(|window| window == [0, 1, 2, 255]));
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"mode\"\r\n\r\nfast\r\n"));
        assert!(text.contains("name=\"files\"; filename=\"笔记.txt\"\r\nContent-Type: text/plain"));
    }

    #[test]
    fn multipart_rejects_invalid_file_payloads() {
        let result = encode_multipart(vec![DesktopFormField {
            name: "files".into(),
            value: None,
            filename: Some("bad.txt".into()),
            content_type: None,
            data_base64: Some("not base64".into()),
        }]);
        assert!(result.is_err());
    }
}
