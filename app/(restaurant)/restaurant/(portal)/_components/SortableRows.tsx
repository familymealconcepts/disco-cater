'use client'
/**
 * Drag-to-reorder for table rows and list rows, on @dnd-kit.
 *
 * Extracted from manage-v2/menus, which was the only @dnd-kit implementation in
 * the codebase; four others were hand-rolled HTML5 draggable with their own
 * draggedRef/dragOverRef state. Five idioms for one behaviour is how they drift
 * — this is the one, and the hand-rolled ones are migrated onto it.
 *
 * OPTIMISTIC WITH ROLLBACK. `onReorder` gets the new order and returns whether
 * the save succeeded; on false the previous order is restored. The code this
 * replaces applied optimistically and never rolled back, so a failed save left
 * the screen showing an order the database did not have.
 */
import { useEffect, useState } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/** 6px so a click still opens the row rather than starting a drag. */
const ACTIVATION_DISTANCE = 6

export interface SortableRowRenderArgs {
  /** Spread onto the drag handle cell/element. Only the handle starts a drag. */
  handleProps: Record<string, unknown>
  isDragging: boolean
  index: number
}

export function SortableRows<T>({
  items, getKey, onReorder, children, as = 'tbody', disabled = false, getRowProps,
}: {
  items: T[]
  getKey: (item: T) => string
  /** Per-row style/handlers merged onto the row element SortableRows renders —
   *  row-level click-to-edit, dimming for hidden rows, and so on. */
  getRowProps?: (item: T) => { style?: React.CSSProperties; onClick?: (e: React.MouseEvent) => void }
  /** Persist the new order. Return false (or throw) to roll the UI back. */
  onReorder: (orderedKeys: string[], orderedItems: T[]) => Promise<boolean>
  children: (item: T, args: SortableRowRenderArgs) => React.ReactNode
  /** 'tbody' for tables, 'div' for lists. */
  as?: 'tbody' | 'div'
  disabled?: boolean
}) {
  const [override, setOverride] = useState<T[] | null>(null)
  const [saving, setSaving] = useState(false)
  // DndContext renders its own screen-reader announcer and hidden-description
  // <div>s as siblings of its children. When `as` is 'tbody' those siblings
  // would land inside <table>, which is invalid HTML and throws a hydration
  // error ("<div> cannot be a child of <table>"). Portalling them to <body>
  // keeps the announcer working and the table valid. manage-v2/menus never hit
  // this because its DndContext wraps the whole <table> from outside.
  const [a11yContainer, setA11yContainer] = useState<HTMLElement | undefined>(undefined)
  useEffect(() => { setA11yContainer(document.body) }, [])
  // While a save is in flight the optimistic order is shown; if it fails the
  // override is dropped and the parent's own list (unchanged) shows through.
  const shown = override ?? items
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }))

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = shown.findIndex(i => getKey(i) === active.id)
    const newIndex = shown.findIndex(i => getKey(i) === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const previous = shown
    const reordered = arrayMove(shown, oldIndex, newIndex)
    setOverride(reordered)
    setSaving(true)
    try {
      const ok = await onReorder(reordered.map(getKey), reordered)
      if (!ok) setOverride(previous)
      else setOverride(null) // parent state is now authoritative
    } catch {
      setOverride(previous)
    } finally {
      setSaving(false)
    }
  }

  const Wrapper = as
  const body = (
    <SortableContext items={shown.map(getKey)} strategy={verticalListSortingStrategy}>
      {shown.map((item, index) => (
        <SortableRow key={getKey(item)} id={getKey(item)} as={as} disabled={disabled || saving} rowProps={getRowProps?.(item)}>
          {(args) => children(item, { ...args, index })}
        </SortableRow>
      ))}
    </SortableContext>
  )

  if (disabled) {
    const Row = as === 'tbody' ? 'tr' : 'div'
    return <Wrapper>{shown.map((item, index) => (
      <Row key={getKey(item)} {...(getRowProps?.(item) ?? {})}>{children(item, { handleProps: {}, isDragging: false, index })}</Row>
    ))}</Wrapper>
  }

  return (
    <DndContext
      sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}
      accessibility={a11yContainer ? { container: a11yContainer } : undefined}
    >
      <Wrapper>{body}</Wrapper>
    </DndContext>
  )
}

function SortableRow({
  id, as, disabled, children, rowProps,
}: {
  id: string
  as: 'tbody' | 'div'
  disabled: boolean
  rowProps?: { style?: React.CSSProperties; onClick?: (e: React.MouseEvent) => void }
  children: (args: Omit<SortableRowRenderArgs, 'index'>) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  const style: React.CSSProperties = {
    ...(rowProps?.style ?? {}),
    transform: CSS.Transform.toString(transform),
    transition,
    background: isDragging ? '#f5f6ff' : rowProps?.style?.background,
    boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.08)' : undefined,
  }
  const handleProps = {
    ...attributes, ...listeners,
    // touchAction:none is required or a touch drag scrolls the page instead.
    style: { cursor: disabled ? 'default' : 'grab', touchAction: 'none', color: '#bbb', userSelect: 'none' as const },
    title: 'Drag to reorder',
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  }
  if (as === 'tbody') return <tr ref={setNodeRef} style={style} onClick={rowProps?.onClick}>{children({ handleProps, isDragging })}</tr>
  return <div ref={setNodeRef} style={style} onClick={rowProps?.onClick}>{children({ handleProps, isDragging })}</div>
}

/** The handle glyph, so every table shows the same affordance. */
export const DRAG_GLYPH = '⋮⋮'
