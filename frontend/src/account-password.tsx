import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import { Modal } from "./teacher/ui";
import { userFacingRequestError } from "./user-facing-error";

export type PasswordField = "current" | "new" | "confirm";

/** The first problem with the form, and the field it belongs to (marked invalid and focused). */
export function passwordChangeProblem(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): { field: PasswordField; message: string } | null {
  if (!currentPassword) return { field: "current", message: "请输入当前密码" };
  if (newPassword.length < 12) return { field: "new", message: "密码至少 12 个字符" };
  if (newPassword.length > 256) return { field: "new", message: "新密码不能超过 256 个字符" };
  if (!newPassword.trim()) return { field: "new", message: "新密码不能全是空格" };
  if (newPassword === currentPassword) return { field: "new", message: "新密码不能与当前密码相同" };
  if (newPassword !== confirmation) return { field: "confirm", message: "两次输入的新密码不一致" };
  return null;
}

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string | null {
  return passwordChangeProblem(currentPassword, newPassword, confirmation)?.message ?? null;
}

const ERROR_ID = "account-password-error";

/** 当前账号自助改密。成功后所有设备都要重新登录，本页回到登录页。 */
export function AccountPasswordModal({
  onClose,
  onChanged,
  returnFocusRef,
}: {
  onClose: () => void;
  onChanged: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [invalidField, setInvalidField] = useState<PasswordField | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A field problem focuses that field (the alert reads the reason); a refused change focuses the reason.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error) return;
    const field = invalidField === "current" ? currentPasswordRef
      : invalidField === "new" ? newPasswordRef
      : invalidField === "confirm" ? confirmationRef : errorRef;
    field.current?.focus();
  }, [error, invalidField]);
  const fieldProps = (field: PasswordField) => invalidField === field
    ? { "aria-invalid": true as const, "aria-describedby": ERROR_ID }
    : {};
  const edit = (field: PasswordField, set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    if (invalidField === field) setInvalidField(null);
  };

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = passwordChangeProblem(currentPassword, newPassword, confirmation);
    if (problem) {
      setInvalidField(problem.field);
      setError(problem.message);
      return;
    }
    setBusy(true);
    setError(null);
    setInvalidField(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      onChanged();
    } catch (cause) {
      setError(userFacingRequestError(cause, "修改失败"));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="修改登录密码"
      onClose={close}
      width={420}
      initialFocusRef={currentPasswordRef}
      returnFocusRef={returnFocusRef}
    >
      {/* noValidate: the browser's own minLength bubble would hide our Chinese messages. */}
      <form className="modal-form" noValidate onSubmit={submit}>
        <p className="modal-msg account-password-note">
          修改成功后，所有设备都会退出登录，请用新密码重新登录。
        </p>

        <label htmlFor="account-current-password">当前密码</label>
        <input
          ref={currentPasswordRef}
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={edit("current", setCurrentPassword)}
          {...fieldProps("current")}
        />

        <label htmlFor="account-new-password">新密码</label>
        <input
          ref={newPasswordRef}
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={newPassword}
          onChange={edit("new", setNewPassword)}
          {...fieldProps("new")}
        />
        <p className="muted" style={{ margin: "-4px 0 10px" }}>至少 12 个字符</p>

        <label htmlFor="account-confirm-password">再次输入新密码</label>
        <input
          ref={confirmationRef}
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={confirmation}
          onChange={edit("confirm", setConfirmation)}
          {...fieldProps("confirm")}
        />

        {error && <div ref={errorRef} id={ERROR_ID} tabIndex={-1} className="error-box account-password-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "正在修改…" : "修改并重新登录"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
