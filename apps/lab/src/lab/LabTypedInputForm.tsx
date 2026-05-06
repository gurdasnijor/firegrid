import styles from "./styles.module.css"

interface LabTypedInputFormProps {
  readonly message: string
  readonly count: number
  readonly submitLabel: string
  readonly onMessageChange: (value: string) => void
  readonly onCountChange: (value: number) => void
  readonly onSubmit: () => void
}

export function LabTypedInputForm({
  message,
  count,
  submitLabel,
  onMessageChange,
  onCountChange,
  onSubmit,
}: LabTypedInputFormProps) {
  return (
    <>
      <label className={styles.label}>
        Message
        <input
          className={styles.input}
          value={message}
          onChange={(event) => onMessageChange(event.currentTarget.value)}
        />
      </label>
      <label className={styles.label}>
        Count
        <input
          className={styles.input}
          type="number"
          value={count}
          onChange={(event) =>
            onCountChange(Number.parseInt(event.currentTarget.value, 10) || 0)
          }
        />
      </label>
      <button
        className={styles.button}
        type="button"
        onClick={onSubmit}
        disabled={message.trim().length === 0}
      >
        {submitLabel}
      </button>
    </>
  )
}
