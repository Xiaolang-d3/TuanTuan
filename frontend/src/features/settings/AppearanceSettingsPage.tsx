import { Moon, Palette, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../appearance/ThemeProvider";
import "./appearance-settings.css";

const options = [
  { value: "light", title: "浅色", description: "明亮背景，适合白天使用", Icon: Sun },
  { value: "dark", title: "深色", description: "深色背景，适合低光环境", Icon: Moon },
  { value: "blue", title: "主题色蓝", description: "使用团团品牌蓝作为主题色", Icon: Palette }
] as const;
export function AppearanceSettingsPage() {
  const { preference, resolved, setPreference } = useTheme();
  return <section className="appearance-settings" aria-labelledby="appearance-title">
    <header><h2 id="appearance-title">外观</h2><p>统一设置首页、文件库、AI 工作区和设置的主题。</p></header>
    <fieldset className="appearance-options"><legend>主题</legend>{options.map(({ value, title, description, Icon }) => <label key={value} className={`appearance-option ${preference === value ? "is-selected" : ""}`}>
      <input type="radio" name="app-theme" value={value} checked={preference === value} onChange={() => setPreference(value as ThemePreference)} />
      <span className={`appearance-preview preview-${value}`} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
      <span className="appearance-option-title"><Icon size={16} /><strong>{title}</strong></span><small>{description}</small>
    </label>)}</fieldset>
    <p className="appearance-current" role="status">当前使用{resolved === "dark" ? "深色" : resolved === "blue" ? "主题色蓝" : "浅色"}主题。</p>
    <p className="appearance-note">修改立即生效，保存在当前设备；刷新页面和切换模块后保留。</p>
  </section>;
}
