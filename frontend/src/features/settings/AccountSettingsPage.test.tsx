import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSettingsPage } from "./AccountSettingsPage";
import type { AuthUser } from "../../components/AuthGate";

const raster = vi.hoisted(() => ({ presetAvatarFile: vi.fn<(preset: { id: string }) => Promise<File>>() }));
vi.mock("./avatar-raster", () => ({ presetAvatarFile: raster.presetAvatarFile }));

const account: AuthUser = {
  id: 1,
  email: "owner@example.com",
  display_name: "",
  has_avatar: false
};

function props(overrides: Partial<Parameters<typeof AccountSettingsPage>[0]> = {}) {
  return {
    apiBase: "https://app.example.com",
    accessToken: "token-1",
    account,
    avatarUrl: null,
    onAccountChange: vi.fn(),
    onPasswordChanged: vi.fn(),
    ...overrides
  };
}

describe("AccountSettingsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    raster.presetAvatarFile.mockReset();
  });

  it("keeps account identity separate from the career profile", () => {
    render(<AccountSettingsPage {...props()} />);

    expect(screen.getByText("昵称和头像保存在本机账户中，与资料库内容分开。")).toBeInTheDocument();
    expect(document.querySelector(".account-avatar-glyph")).toHaveTextContent("O");
    expect(screen.getByText("登录邮箱")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "登录邮箱" })).not.toBeInTheDocument();
    expect(screen.queryByText("我的求职资料")).not.toBeInTheDocument();
  });

  it("only asks to save a nickname after it changes", () => {
    render(<AccountSettingsPage {...props()} />);
    expect(screen.queryByRole("button", { name: "保存昵称" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "小林" } });

    expect(screen.getByRole("button", { name: "保存昵称" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("lets the person discard an unsaved nickname", () => {
    render(<AccountSettingsPage {...props({ account: { ...account, display_name: "小林" } })} />);
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "小王" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByLabelText("昵称")).toHaveValue("小林");
    expect(screen.queryByRole("button", { name: "保存昵称" })).not.toBeInTheDocument();
  });

  it("saves a nickname to the signed-in account", async () => {
    const onAccountChange = vi.fn();
    const nextUser = { ...account, display_name: "小林" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://app.example.com/auth/me");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ display_name: "小林" });
      return new Response(JSON.stringify({ user: nextUser }), { status: 200 });
    }));

    render(<AccountSettingsPage {...props({ onAccountChange })} />);
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "小林" } });
    fireEvent.click(screen.getByRole("button", { name: "保存昵称" }));

    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith(nextUser));
    expect(await screen.findByText("昵称已保存")).toBeInTheDocument();
  });

  it("rejects mismatched new passwords before calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountSettingsPage {...props()} />);

    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "a-new-test-password" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "another-test-password" } });

    expect(screen.getByRole("alert")).toHaveTextContent("两次输入的新密码不一致");
    expect(screen.getByRole("button", { name: "更新密码" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the session after a successful password change", async () => {
    const onPasswordChanged = vi.fn();
    const nextUser = { ...account, display_name: "小林" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://app.example.com/auth/me/password");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ current_password: "old-password", new_password: "rkt9876543!" });
      return new Response(JSON.stringify({ access_token: "token-2", user: nextUser }), { status: 200 });
    }));

    render(<AccountSettingsPage {...props({ onPasswordChanged })} />);
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "rkt9876543!" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "rkt9876543!" } });
    fireEvent.click(screen.getByRole("button", { name: "更新密码" }));

    await waitFor(() => expect(onPasswordChanged).toHaveBeenCalledWith("token-2", nextUser));
    expect(await screen.findByText("密码已更新，当前登录仍然有效")).toBeInTheDocument();
  });

  it("requires the new policy at password change and leaves the old password unrestricted", () => {
    render(<AccountSettingsPage {...props()} />);
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old" } });
    const password = screen.getByLabelText("新密码");
    expect(password).not.toHaveAttribute("maxlength");
    for (const value of ["x".repeat(7), "passwordpassword", "12345678", "x".repeat(129)]) {
      fireEvent.change(password, { target: { value } });
      fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value } });
      expect(screen.getByRole("button", { name: "更新密码" })).toBeDisabled();
      expect(password).toHaveAttribute("aria-invalid", "true");
    }
    fireEvent.change(password, { target: { value: "a long memorable phrase" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "a long memorable phrase" } });
    expect(screen.getByRole("button", { name: "更新密码" })).toBeEnabled();
    expect(password).toHaveAttribute("aria-invalid", "false");
  });

  it("uploads an avatar for the current account", async () => {
    const onAccountChange = vi.fn();
    const nextUser = { ...account, has_avatar: true };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://app.example.com/auth/me/avatar");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ user: nextUser }), { status: 200 });
    }));

    render(<AccountSettingsPage {...props({ onAccountChange })} />);
    const file = new File(["avatar"], "face.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] }
    });

    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith(nextUser));
    expect(await screen.findByText("头像已更新")).toBeInTheDocument();
  });

  it("checks the avatar locally before uploading", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountSettingsPage {...props()} />);
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "face.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] }
    });

    expect(screen.getByRole("alert")).toHaveTextContent("图片不能超过 2MB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a row of built-in avatars next to the upload entry", () => {
    render(<AccountSettingsPage {...props()} />);

    const picker = screen.getByRole("group", { name: "奶龙头像" });
    const tiles = within(picker).getAllByRole("button");
    expect(tiles).toHaveLength(12);
    expect(tiles[0]).toHaveAccessibleName("使用开心奶龙");
    expect(tiles[0]).toHaveAttribute("aria-pressed", "false");
    expect(picker.querySelectorAll("img")).toHaveLength(12);
    // A photo upload stays available, so nothing is taken away from the person.
    expect(screen.getAllByRole("button", { name: "上传头像" })).toHaveLength(2);
  });

  it("applies a built-in avatar through the same upload endpoint", async () => {
    const onAccountChange = vi.fn();
    const nextUser = { ...account, has_avatar: true };
    const png = new File([new Uint8Array(1024)], "nailong-cheer.png", { type: "image/png" });
    raster.presetAvatarFile.mockResolvedValue(png);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://app.example.com/auth/me/avatar");
      expect(init?.method).toBe("POST");
      const sent = (init?.body as FormData).get("file") as File;
      expect(sent.name).toBe("nailong-cheer.png");
      return new Response(JSON.stringify({ user: nextUser }), { status: 200 });
    }));

    render(<AccountSettingsPage {...props({ onAccountChange })} />);
    const picker = screen.getByRole("group", { name: "奶龙头像" });
    const cheer = within(picker).getByRole("button", { name: "使用加油奶龙" });
    fireEvent.click(cheer);

    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith(nextUser));
    expect(await screen.findByText("已换成加油奶龙")).toBeInTheDocument();
    expect(cheer).toHaveAttribute("aria-pressed", "true");
    expect(raster.presetAvatarFile).toHaveBeenCalledWith(expect.objectContaining({ id: "nailong-cheer" }));
  });

  it("reports a built-in avatar that cannot be prepared", async () => {
    const onAccountChange = vi.fn();
    const fetchMock = vi.fn();
    raster.presetAvatarFile.mockRejectedValue(new Error("头像素材加载失败"));
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountSettingsPage {...props({ onAccountChange })} />);
    const cheff = within(screen.getByRole("group", { name: "奶龙头像" })).getByRole("button", { name: "使用开心奶龙" });
    fireEvent.click(cheff);

    expect(await screen.findByRole("alert")).toHaveTextContent("头像素材加载失败");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAccountChange).not.toHaveBeenCalled();
    expect(cheff).toHaveAttribute("aria-pressed", "false");
  });

  it("clears the built-in selection once a photo is uploaded", async () => {
    const nextUser = { ...account, has_avatar: true };
    raster.presetAvatarFile.mockResolvedValue(new File([new Uint8Array(64)], "nailong-wink.png", { type: "image/png" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: nextUser }), { status: 200 })));

    render(<AccountSettingsPage {...props()} />);
    const picker = screen.getByRole("group", { name: "奶龙头像" });
    const wink = within(picker).getByRole("button", { name: "使用眨眼奶龙" });
    fireEvent.click(wink);
    await waitFor(() => expect(wink).toHaveAttribute("aria-pressed", "true"));

    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["photo"], "face.png", { type: "image/png" })] }
    });

    await waitFor(() => expect(wink).toHaveAttribute("aria-pressed", "false"));
    expect(await screen.findByText("头像已更新")).toBeInTheDocument();
  });
});
