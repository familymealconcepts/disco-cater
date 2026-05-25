export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function formatDollars(amount: number): string {
  return `$${(amount || 0).toFixed(2)}`
}

export function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}
