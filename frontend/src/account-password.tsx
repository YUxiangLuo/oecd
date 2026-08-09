import { useState } from "react";
import { api } from "./api";
import { Modal } from "./teacher/ui";

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string | null {
  if (!currentPassword) return "请输入当前密码";
  if (newPassword.length < 12) return "新密码至少需要 12 个字符";
  if (newPassword.length > 256) return "新密码不能超过 256 个字符";
  if (newPassword === currentPassword) return "新密码不能与当前密码相同";
  if (newPassword !== confirmation) return "两次输入的新密码不一致";
  return null;
}

/** 当前账号自助改密。成功后服务端撤销该账号全部会话，调用方负责回到登录页。 */
export function AccountPasswordModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validatePasswordChange(currentPassword, newPassword, confirmation);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      onChanged();
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
      setBusy(false);
    }
  };

  return (
    <Modal title="修改登录密码" onClose={close} width={420}>
      <form className="modal-form" onSubmit={submit}>
        <p className="modal-msg account-password-note">
          修改成功后，此账号在所有浏览器中的既有会话都会撤销，你需要使用新密码重新登录。
        </p>

        <label htmlFor="account-current-password">当前密码</label>
        <input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          maxLength={256}
          value={currentPassword}
          autoFocus
          onChange={(event) => setCurrentPassword(event.target.value)}
        />

        <label htmlFor="account-new-password">新密码</label>
        <input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />

        <label htmlFor="account-confirm-password">再次输入新密码</label>
        <input
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        {error && <div className="error-box account-password-error" role="alert">{error}</div>}
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
