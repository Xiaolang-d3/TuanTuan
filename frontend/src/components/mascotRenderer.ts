// Deform only the character's source coordinates. The desk remains pixel-still.
const vertexSource = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform float u_blink;
uniform float u_breath;
uniform float u_wave;
varying vec2 v_uv;

vec2 rotatePoint(vec2 p, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

vec2 blinkEye(vec2 p, vec2 center, float angle, float radius) {
  vec2 q = rotatePoint(p - center, -angle);
  float outer = radius + 35.0;
  float y = abs(q.y);
  if (y >= outer || abs(q.x) >= 42.0) return p;
  float scale = 1.0 - 0.90 * u_blink;
  float lid = radius * scale;
  float mapped = y < lid ? y / scale : mix(radius, outer, (y - lid) / (outer - lid));
  float weight = 1.0 - smoothstep(28.0, 42.0, abs(q.x));
  return p + rotatePoint(vec2(0.0, (mapped - y) * sign(q.y) * weight), angle);
}

void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_size;
  // Below the robot, sample the original image with no displacement at all.
  if (p.y < 700.0) {
    vec2 head = (p - vec2(800.0, 390.0)) / vec2(330.0, 300.0);
    float headWeight = exp(-2.0 * dot(head, head)) * (1.0 - smoothstep(640.0, 700.0, p.y));
    p.y -= u_breath * headWeight;
    vec2 hand = p - vec2(465.0, 540.0);
    vec2 area = (p - vec2(425.0, 425.0)) / vec2(170.0, 185.0);
    float handWeight = exp(-2.0 * dot(area, area)) * (1.0 - smoothstep(590.0, 680.0, p.y));
    p += (rotatePoint(hand, -u_wave) - hand) * handWeight;
    p = blinkEye(p, vec2(716.0, 367.0), 0.30, 48.0);
    p = blinkEye(p, vec2(905.0, 416.0), 0.30, 50.0);
  }
  gl_FragColor = texture2D(u_image, vec2(p.x / u_size.x, 1.0 - p.y / u_size.y));
}`;

export function createMascotRenderer(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  function dispose() {
    shaders.forEach(shader => gl!.deleteShader(shader));
    gl!.deleteProgram(program);
    gl!.deleteBuffer(buffer);
    gl!.deleteTexture(texture);
  }
  if (!program || !buffer || !texture) { dispose(); return null; }
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
    const shader = gl.createShader(type);
    if (!shader) { dispose(); return null; }
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { dispose(); return null; }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
  gl.uniform2f(gl.getUniformLocation(program, "u_size"), image.naturalWidth, image.naturalHeight);
  const blink = gl.getUniformLocation(program, "u_blink");
  const breath = gl.getUniformLocation(program, "u_breath");
  const wave = gl.getUniformLocation(program, "u_wave");
  function resize() {
    const bounds = canvas.parentElement!.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(bounds.width * density));
    const height = Math.max(1, Math.round(bounds.height * density));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl!.viewport(0, 0, width, height);
  }
  function draw(seconds: number) {
    const phase = seconds % 6.8;
    const closing = Math.max(Math.exp(-Math.pow((phase - 3.0) / .09, 2)), .9 * Math.exp(-Math.pow((phase - 3.35) / .08, 2)));
    const greeting = seconds % 12;
    const envelope = greeting < 2 ? Math.pow(Math.sin(Math.PI * greeting / 2), 2) : 0;
    gl!.uniform1f(blink, closing);
    gl!.uniform1f(breath, Math.sin(seconds * 1.5) * 3.5);
    gl!.uniform1f(wave, Math.sin(greeting * 8) * envelope * .075);
    gl!.drawArrays(gl!.TRIANGLES, 0, 6);
  }
  return { draw, resize, dispose };
}
