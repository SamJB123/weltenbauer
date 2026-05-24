/**
 * Small, dependency-free UI toolkit for the Weltbuilder panel. Each factory
 * returns a ready-to-append HTMLElement and wires its own events. State sync is
 * done by re-rendering a panel (stages are cheap to rebuild), so controls don't
 * need two-way binding — they just report changes via their callbacks.
 */

type Attrs = {
  class?: string
  text?: string
  style?: Partial<CSSStyleDeclaration>
  /** Any other DOM property (value, type, min, href, checked, …) is assigned directly. */
  [key: string]: unknown
}

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: cls, text, style, ...rest } = attrs
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  if (style) Object.assign(node.style, style)
  Object.assign(node, rest)
  for (const c of children) node.append(c)
  return node
}

/** A labelled row wrapping a control. */
export function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'w-field' }, [h('span', { class: 'w-field-label', text: label }), control])
}

export interface SliderOpts {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  /** Fire on every drag (input) rather than only on release (change). */
  live?: boolean
  format?: (v: number) => string
  onChange: (v: number) => void
}

/** Range slider with a live numeric readout. */
export function slider(o: SliderOpts): HTMLElement {
  const readout = h('span', { class: 'w-slider-val' })
  const input = h('input', {
    class: 'w-slider', type: 'range',
    min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.value)
  } as any)
  const fmt = (v: number) => o.format ? o.format(v) : `${v}${o.unit ? ' ' + o.unit : ''}`
  readout.textContent = fmt(o.value)
  input.addEventListener('input', () => {
    const v = parseFloat(input.value)
    readout.textContent = fmt(v)
    if (o.live) o.onChange(v)
  })
  input.addEventListener('change', () => { if (!o.live) o.onChange(parseFloat(input.value)) })
  return h('div', { class: 'w-field w-field-col' }, [
    h('div', { class: 'w-field-head' }, [h('span', { class: 'w-field-label', text: o.label }), readout]),
    input
  ])
}

export interface SelectOpts<T extends string | number> {
  label: string
  value: T
  options: { label: string; value: T }[]
  onChange: (v: T) => void
}

export function select<T extends string | number>(o: SelectOpts<T>): HTMLElement {
  const sel = h('select', { class: 'w-select' })
  for (const opt of o.options) {
    const el = h('option', { text: opt.label, value: String(opt.value) })
    if (opt.value === o.value) el.selected = true
    sel.append(el)
  }
  sel.addEventListener('change', () => {
    const raw = sel.value
    const match = o.options.find(opt => String(opt.value) === raw)!
    o.onChange(match.value)
  })
  return field(o.label, sel)
}

export function toggle(o: { label: string; value: boolean; onChange: (v: boolean) => void }): HTMLElement {
  const input = h('input', { class: 'w-toggle', type: 'checkbox' } as any)
  input.checked = o.value
  input.addEventListener('change', () => o.onChange(input.checked))
  return field(o.label, input)
}

export interface ButtonOpts {
  label: string
  onClick: () => void
  kind?: 'primary' | 'ghost' | 'danger'
  full?: boolean
}

export function button(o: ButtonOpts): HTMLButtonElement {
  const btn = h('button', {
    class: `w-btn w-btn-${o.kind ?? 'ghost'}${o.full ? ' w-btn-full' : ''}`,
    text: o.label
  })
  btn.addEventListener('click', o.onClick)
  return btn
}

/** A button that opens a file picker and hands back the chosen File. */
export function fileButton(o: { label: string; accept: string; onFile: (file: File) => void; kind?: ButtonOpts['kind'] }): HTMLElement {
  const input = h('input', { type: 'file', accept: o.accept, style: { display: 'none' } } as any)
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (f) o.onFile(f)
    input.value = ''
  })
  const btn = button({ label: o.label, kind: o.kind, full: true, onClick: () => input.click() })
  return h('div', {}, [btn, input])
}

/** A collapsible section. Returns the root plus its body (append controls there). */
export function group(title: string, opts: { open?: boolean } = {}): { root: HTMLElement; body: HTMLElement } {
  const body = h('div', { class: 'w-group-body' })
  const caret = h('span', { class: 'w-group-caret', text: '▸' })
  const header = h('button', { class: 'w-group-head' }, [caret, h('span', { text: title })])
  const root = h('div', { class: 'w-group' }, [header, body])
  const setOpen = (open: boolean) => {
    root.classList.toggle('w-open', open)
    caret.textContent = open ? '▾' : '▸'
  }
  header.addEventListener('click', () => setOpen(!root.classList.contains('w-open')))
  setOpen(opts.open ?? false)
  return { root, body }
}

/** A short explanatory line. */
export function hint(text: string): HTMLElement {
  return h('p', { class: 'w-hint', text })
}
