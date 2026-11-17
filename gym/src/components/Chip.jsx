import styles from './Chip.module.css'

export default function Chip({ color = 'neutral', children }) {
  return <span className={`${styles.chip} ${styles[color]}`}>{children}</span>
}
