// Reminder bookkeeping shared by the reminder cron and every path that moves an
// order's date or time.
//
// ONE REMINDER PER DATE AND TIME, NOT PER ORDER. The customer claim used to be
// "an ORDER_REMINDER_SENT event exists for this order", and the restaurant claim
// a one-way admin_reminder_sent flag — so an order moved AFTER its reminder went
// out was never reminded about its new date. The customer claim now carries the
// date/time it was for (reminderKey); the restaurant flag is cleared in the same
// UPDATE that moves the date or time (edit route, applyPendingEdit, Super Admin
// date/time). Neither can send a backdated reminder: the cron only picks orders
// whose time is 23.5–24.5 hours away.

/** "YYYY-MM-DD HH:MM" — what a reminder was sent for. */
export function reminderKey(orderDate: string, orderTime: string): string {
  return `${String(orderDate).slice(0, 10)} ${String(orderTime).slice(0, 5)}`
}
