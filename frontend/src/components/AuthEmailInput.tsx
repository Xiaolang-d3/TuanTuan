import { RefObject, useEffect, useRef, useState } from "react";

const commonEmailDomains = [
  "qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "icloud.com",
  "hotmail.com", "foxmail.com", "yeah.net", "sina.com", "sina.cn", "sohu.com", "yahoo.com"
];

function suggestEmails(value: string): string[] {
  const email = value.trim();
  const [name, domain = ""] = email.split("@");
  if (!name || /\s/.test(email) || email.split("@").length > 2) return [];
  return commonEmailDomains
    .filter((candidate) => candidate.startsWith(domain.toLowerCase()) && candidate !== domain.toLowerCase())
    .map((candidate) => `${name}@${candidate}`)
    .filter((candidate) => candidate.length <= 320)
    .slice(0, 6);
}

type Props = {
  value: string;
  registering: boolean;
  disabled: boolean;
  error?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
};

export function AuthEmailInput({ value, registering, disabled, error, inputRef, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeOption = useRef<HTMLButtonElement>(null);
  const suggestions = suggestEmails(value);
  const expanded = open && !disabled && suggestions.length > 0;

  useEffect(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, [registering, disabled]);

  useEffect(() => {
    activeOption.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, activeIndex]);

  function selectEmail(email: string) {
    onChange(email);
    setOpen(false);
    setActiveIndex(-1);
  }

  return (
    <div className="auth-email-field">
      <input
        id="auth-email"
        ref={inputRef}
        type={registering ? "email" : "text"}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? "auth-email-suggestions" : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? `auth-email-option-${activeIndex}` : undefined}
        maxLength={320}
        autoCapitalize="none"
        spellCheck={false}
        inputMode="email"
        name="username"
        autoComplete="username"
        placeholder="请输入邮箱"
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "auth-email-error" : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => { setOpen(false); setActiveIndex(-1); }}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
            event.preventDefault();
            setOpen(true);
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((current) => !expanded || current < 0
              ? direction === 1 ? 0 : suggestions.length - 1
              : (current + direction + suggestions.length) % suggestions.length);
          } else if (event.key === "Enter" && expanded && activeIndex >= 0) {
            event.preventDefault();
            selectEmail(suggestions[activeIndex]);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
          } else if (event.key === "Tab") {
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
      />
      <label className="auth-floating-label" htmlFor="auth-email">邮箱</label>
      {expanded ? (
        <div className="auth-email-suggestions" id="auth-email-suggestions" role="listbox" aria-label="常见邮箱建议">
          {suggestions.map((email, index) => (
            <button
              key={email}
              ref={activeIndex === index ? activeOption : undefined}
              id={`auth-email-option-${index}`}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectEmail(email)}
            >
              {email}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
