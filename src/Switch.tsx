/**
 * One binary state, one control.
 *
 * Channels and bots used to expose "暂停 / 启用" as a text button that sat in a
 * row of equal-looking buttons, so the single most consequential choice on the
 * card looked like a mere action. A switch reads as a state: on means "it is
 * pushing right now", off means "it is not".
 */
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`toggle${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" aria-hidden="true" />
    </button>
  );
}
