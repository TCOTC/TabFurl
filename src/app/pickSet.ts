import {planPickClick} from './pick'

/**
 * 一块列表的**多选状态**——三块列表（窗口标签 / 两个收藏夹栏）共用这一个实现。
 *
 * 两栏的差别只剩三样**数据**，都从 `deps` 递进来：
 * - `parentOf`：行与它所属容器的关系（收藏夹是书签树的父链，窗口栏是「组内标签 → 分组」）；
 * - `rangeTo`：Shift 范围怎么取（各栏自己知道行在屏幕上怎么排）；
 * - `selectable`：这一档里哪些行点得动（收藏夹的「打开」档只认会被打开的行；窗口栏没有这条限制）。
 *
 * 三样以外**没有第二套逻辑**：选中集只有一份（一个 `Set<string>`）、归约只有一处（选中容器就把
 * 后代剔掉）、`Ctrl / Shift / 普通点击` 的判定只在 `pick.ts` 里。
 *
 * 曾经的做法是两栏各存一套（窗口栏还分成「标签集合 + 分组集合」两个），于是同一句话
 * 要写两遍、判两遍，而其中一遍的 Shift 是「追加」、另一遍是「替换」——两种结果都自洽，
 * 只有并排用才看得出来。**行的键就是它 DOM 上的 `data-pick-line`**，于是「哪一行被选中」
 * 和「界面上哪一行亮着」用的是同一串东西，不必再做一次映射。
 */
export interface PickSetDeps {
  /** 这一条所属容器（分组 / 文件夹）；顶层行返回 `undefined`。 */
  parentOf(id: string): string | undefined
  /**
   * Shift 范围：按**可见顺序**取 `from` 到 `to` 之间的那一批键。
   * `from` 是起点（还没点过任何一行时为 `undefined`）。
   */
  rangeTo(from: string | undefined, to: string): string[]
  /** 这一档里这一条点不点得动。省略 = 这一栏没有范围概念。 */
  selectable?(id: string): boolean
}

export interface PickSet {
  readonly size: number
  /** 这一条**自己**被选中（容器看容器自己，不看它里面的行）。 */
  has(id: string): boolean
  /** 这一条在不在框里：自己被选中，或某个祖先被选中。 */
  within(id: string): boolean
  /** 被点选的键（已归约：不含「祖先也选中」的后代）。 */
  ids(): readonly string[]  /** 一次性拿走一份只读集合（给 `splitPicked` 这类纯函数用）。 */
  snapshot(): ReadonlySet<string>
  /** 取消整批选择。 */
  clear(): void
  /** 只删这一条（关掉的标签、被撤销的条目）。 */
  delete(id: string): void
  /** 键换了（释放会让 tab id 变）：把选中一起搬过去。 */
  rename(oldId: string, newId: string): void
  /** 丢掉已经不在名单里的键，并重新归约。 */
  prune(alive: ReadonlySet<string>): void
  /**
   * 处理一次点击。`id` 是点到的行（点空白时省略）。
   * 返回 `false` = 这次点击不该被当成一次选择操作（落在按不动的行上、点空白时本来就没选择）。
   */
  click(input: {id?: string; shift: boolean; toggle: boolean}): boolean
  /** 按给定顺序给出每一行「在不在框里」——绘制高亮段用（首尾由调用方比邻居得出）。 */
  boxFlags(orderedIds: readonly string[], fallback?: (index: number) => boolean): boolean[]
}

export function createPickSet(deps: PickSetDeps): PickSet {
  const picked = new Set<string>()
  /** Shift 范围的起点。**Shift 自己永远不挪它**（连按几次要能反复调范围）。 */
  let anchor: string | undefined

  function within(id: string): boolean {
    for (let at: string | undefined = id; at !== undefined; at = deps.parentOf(at)) {
      if (picked.has(at)) return true
    }
    return false
  }

  /** 选中容器之后把被它覆盖的后代剔掉：它们本来就在框里，单列只会是一堆点了没反应的冗余项。 */
  function dropNested(): void {
    for (const id of [...picked]) {
      for (let at = deps.parentOf(id); at !== undefined; at = deps.parentOf(at)) {
        if (picked.has(at)) {
          picked.delete(id)
          break
        }
      }
    }
  }

  function replaceWith(ids: readonly string[]): void {
    picked.clear()
    for (const id of ids) picked.add(id)
    dropNested()
  }

  return {
    get size() {
      return picked.size
    },
    has: (id) => picked.has(id),
    within,
    ids: () => [...picked],
    snapshot: () => new Set(picked),
    clear() {
      picked.clear()
      anchor = undefined
    },
    delete(id) {
      picked.delete(id)
    },
    rename(oldId, newId) {
      if (picked.delete(oldId)) picked.add(newId)
      if (anchor === oldId) anchor = newId
    },
    prune(alive) {
      for (const id of [...picked]) if (!alive.has(id)) picked.delete(id)
      dropNested()
    },
    click(input) {
      const id = input.id
      // 落在「这一档按不动」的行上：什么都不做。**别当成点空白**——那会把已选的那批清掉。
      if (id !== undefined && deps.selectable && !deps.selectable(id)) return false

      const intent = planPickClick({
        onBlank: id === undefined,
        shift: input.shift,
        toggle: input.toggle,
        ownSelected: id !== undefined && picked.has(id),
        withinPick: id !== undefined && within(id),
        hasPick: picked.size > 0
      })
      if (intent.action === 'ignore') return false

      if (intent.action === 'clear') picked.clear()
      if (intent.action === 'toggle' && id !== undefined) {
        if (picked.has(id)) {
          // 取消容器时**不**把后代加回来：取消是一次明确的「这一块不要了」。
          picked.delete(id)
        } else {
          picked.add(id)
          dropNested()
        }
      }
      if (intent.action === 'extend' && id !== undefined) replaceWith(deps.rangeTo(anchor, id))

      // 起点必须在动作**之后**设：`clear` 会把起点一并清掉。
      if (intent.moveAnchor && id !== undefined) anchor = id
      return true
    },
    boxFlags(orderedIds, fallback) {
      return orderedIds.map((id, index) => (id ? within(id) : fallback?.(index) === true))
    }
  }
}
