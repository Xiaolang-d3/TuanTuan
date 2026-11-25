import { Autocomplete } from "@base-ui/react/autocomplete";
import { useEffect, useState, type RefObject } from "react";

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
  const suggestions = suggestEmails(value);

  useEffect(() => { setOpen(false); }, [registering, disabled]);

  return (
    <div className="auth-email-field">
      <Autocomplete.Root
        value={value}
        items={suggestions}
        filter={null}
        disabled={disabled}
        open={open && !disabled && suggestions.length > 0}
        openOnInputClick
        onOpenChange={setOpen}
        onValueChange={(next, details) => {
          // Dismissing a closed popup must not clear a custom email address.
          if (details.reason !== "escape-key") onChange(next);
        }}
      >
        <Autocomplete.Input
          id="auth-email"
          ref={inputRef}
          type={registering ? "email" : "text"}
          maxLength={320}
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          name="username"
          autoComplete="username"
          placeholder="请输入邮箱"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "auth-email-error" : undefined}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            // Email inputs support native cursor navigation but not setSelectionRange.
            if (event.nativeEvent.isComposing || (registering && (event.key === "Home" || event.key === "End"))) {
              event.preventBaseUIHandler();
            }
          }}
        />
        <label className="auth-floating-label" htmlFor="auth-email">邮箱</label>
        <Autocomplete.Portal>
          <Autocomplete.Positioner className="auth-email-positioner" sideOffset={5} align="start" collisionPadding={8}>
            <Autocomplete.Popup className="auth-email-suggestions">
              <Autocomplete.List aria-label="常见邮箱建议">
                {suggestions.map((email) => <Autocomplete.Item key={email} value={email}>{email}</Autocomplete.Item>)}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </div>
  );
}
