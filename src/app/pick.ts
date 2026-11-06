/**
 * 一次点选（Ctrl / Shift / 普通点击）该做什么——三块列表共用**这一份**判定。
 *
 * 为什么必须只有一份：窗口栏与收藏夹栏曾各写一遍，于是 Shift 在一栏是「替换范围」、
 * 在另一栏是「追加」，同一个手势得到两种结果，而两边都以为「三块列表是同一套」。
 * 那是**看不出来的分叉**（各自都自洽，只有并排用才露馅）。
 *
 * 这里只决定「动作」，不碰任何数据结构：收藏夹存节点 id、窗口栏存 tabId 与分组键，
 * 由各自的调用方落实。范围选择也留在调用方——两边的行结构不同。
 */

/** 一次点击的意图。 */
export type PickAction =
  /** 什么都不做（落在不让点的行上、或点空白时本来就没有选择）。 */
  | 'ignore'
  /** 取消整批选择。 */
  | 'clear'
  /** Shift：把选择**替换**成「起点到这一条」这一段。 */
  | 'extend'
  /** Ctrl / Cmd：切换这一条。 */
  | 'toggle'
  /** 只挪 Shift 起点，不动选择（点框里那一条、或点框外本来就没有选择）。 */
  | 'keep'

export interface PickIntent {
  action: PickAction
  /**
   * 是否把 Shift 起点挪到这一条上。
   *
   * **Shift 自己永远不挪**：连按几次 Shift 要能反复调范围，每次都拿新结果当起点就调不动了。
   */
  moveAnchor: boolean
}

export interface PickClickInput {
  /** 点在了空白处（没落在任何一行上）。 */
  onBlank: boolean
  /**
   * 这一条本身在不在这一档的可点选范围内。
   *
   * `undefined` = 这一栏没有范围概念（窗口栏每一行都能存）；`false` = 落在行上但这一档不让点
   * （收藏夹栏在「打开」档下更深层的书签、空文件夹、记号）。**两者不是一回事**：
   * 不让点的行要「什么都不做」，当成点空白就会把已选的那批清掉。
   */
  selectable?: boolean
  shift: boolean
  /** Ctrl / Cmd。 */
  toggle: boolean
  /** 这一条**自己**被单独选中（容器看容器自己，不看它里面的行）。 */
  ownSelected: boolean
  /** 这一条在不在框里：自己被选中，或某个祖先被选中。 */
  withinPick: boolean
  /** 这一栏现在有没有选择。 */
  hasPick: boolean
}

const IGNORE: PickIntent = {action: 'ignore', moveAnchor: false}

export function planPickClick(input: PickClickInput): PickIntent {
  // 落在「这一档不让点」的行上：什么都不做。别当成点空白（那会清掉已选好的那批）。
  if (!input.onBlank && input.selectable === false) return IGNORE

  if (input.onBlank) {
    // 点空白取消选择。没有东西可取消时不算「处理过」，交给调用方决定（比如让事件继续冒泡）。
    return input.hasPick ? {action: 'clear', moveAnchor: false} : IGNORE
  }

  if (input.shift) return {action: 'extend', moveAnchor: false}

  if (input.toggle) {
    // 祖先已选中时这一条本来就在框里。再切换它只是往集合里多记一条冗余项
    //（绘制 / 计数 / 拖拽都会把它归到祖先名下），看着就是「点了没反应」。
    if (!input.ownSelected && input.withinPick) return {action: 'keep', moveAnchor: true}
    return {action: 'toggle', moveAnchor: true}
  }

  // 普通点击**不**选中这一条，只按「在不在框里」决定要不要收掉已选的那批：
  // 框里 → 什么都不做（按住它把整批拖走是常见动作，那时选择不该被清掉）；
  // 框外 → 收掉（亮着的框只该靠点别处或那枚按钮收）。
  // 「点一下 = 只选它」不成立：那会让「先 Ctrl 选一批、再随手点一下」变成一次误清空。
  if (input.withinPick) return {action: 'keep', moveAnchor: true}
  return input.hasPick
    ? {action: 'clear', moveAnchor: true}
    : {action: 'keep', moveAnchor: true}
}
