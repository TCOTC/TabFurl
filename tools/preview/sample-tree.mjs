/**
 * 预览桩的默认书签树。
 *
 * 形状刻意对齐 2026-10-03 导出的真实数据，所以它可以当回归基准用：
 * - 书签栏根层 **25 个子级**，形态 `FFFF|FFF|FFFF|FFFF|FFFFFF`（F = 文件夹、`|` = 记号），
 *   记号出现在下标 **4, 8, 13, 18**，根层**没有散装书签**（真书签数 0）。
 * - 两种记号都出现（`index.php?t=horz` 与无查询串的 `index.php`），
 *   并包含真实数据里那种「标题是尾随横杠」的形态（`教程────────────`）。
 * - 有 3 层深的子树（验证缩进与「深层行不给勾选框」），有刻意放大到 300 条的文件夹
 *   （验证虚拟滚动只渲染视口那几十行）。
 * - 「其他书签」里也有文件夹：验证「只能收藏书签栏里的层」这条拒绝规则。
 *
 * 单元格字段只给 `id` / `title` / `url`（文件夹给 `children`），与真实 `getTree()` 返回一致——
 * 桩自己建 `parents` 索引，书签树 JSON 里本来就没有 `parentId`。
 *
 * 要拿真实数据跑，用 `serve.mjs --tree <导出的 tree.json>`。
 */

const SEP_HORZ = 'https://separator.mayastudios.com/index.php?t=horz'
const SEP_PLAIN = 'https://separator.mayastudios.com/index.php'

/** 记号：一枚占位书签，不是书签（计数、勾选、还原都跳过它）。 */
const marker = (id, title, url = SEP_HORZ) => ({id, title, url})
const bookmark = (id, title, url) => ({id, title, url})
const folder = (id, title, children = []) => ({id, title, children})

/** 「大盘」里的书签：够多才能验证虚拟滚动（真实数据全部展开是 11004 行）。 */
function bulkChildren() {
  const children = []
  for (let i = 0; i < 300; i++) {
    // 每 50 条插一条记号：验证深层记号既被画出来、又不计入任何枚数。
    if (i > 0 && i % 50 === 0) children.push(marker(`1-11-${i}`, ''))
    children.push(
      bookmark(
        `1-11-${i}`,
        `第 ${String(i + 1).padStart(3, '0')} 条：示例页面标题`,
        `https://example${i}.test/article/${i}`
      )
    )
  }
  return children
}

export function buildSampleTree() {
  const bar = folder('1', '书签栏', [
    folder('1-0', '工具', [
      folder('1-0-0', '编辑器', [
        bookmark('1-0-0-0', 'VS Code', 'https://code.visualstudio.com/'),
        bookmark('1-0-0-1', 'Neovim', 'https://neovim.io/')
      ]),
      folder('1-0-1', '终端', [bookmark('1-0-1-0', 'Warp', 'https://www.warp.dev/')]),
      // 子层里也放一条：记号在网格里横跨整行，与散装书签混排的次序必须保持。
      marker('1-0-2', '教程────────────'),
      bookmark('1-0-3', 'ripgrep', 'https://github.com/BurntSushi/ripgrep')
    ]),
    folder('1-1', '专题研究', [
      bookmark('1-1-0', '一篇很长的标题用来验证省略号与不换行是否生效的示例文章', 'https://long.example/')
    ]),
    folder('1-2', '内容库', [bookmark('1-2-0', '素材站', 'https://assets.example/')]),
    folder('1-3', '课程专栏', [bookmark('1-3-0', '课程首页', 'https://course.example/')]),
    marker('1-4', ''),
    folder('1-5', '常用', [
      bookmark('1-5-0', '邮箱', 'https://mail.example/'),
      bookmark('1-5-1', '日历', 'https://cal.example/')
    ]),
    folder('1-6', '编程导航', [
      bookmark('1-6-0', 'MDN', 'https://developer.mozilla.org/'),
      bookmark('1-6-1', 'Can I use', 'https://caniuse.com/')
    ]),
    folder('1-7', '前端课程', [bookmark('1-7-0', '前端路线', 'https://roadmap.example/')]),
    marker('1-8', '设计────────'),
    folder('1-9', '设计素材', [bookmark('1-9-0', '图标库', 'https://icons.example/')]),
    folder('1-10', '稍后读', [
      bookmark('1-10-0', '待读一', 'https://read.example/1'),
      bookmark('1-10-1', '待读二', 'https://read.example/2')
    ]),
    folder('1-11', '大盘', bulkChildren()),
    folder('1-12', '效率工具', [bookmark('1-12-0', '清单', 'https://todo.example/')]),
    marker('1-13', '', SEP_PLAIN),
    folder('1-14', '影音', [bookmark('1-14-0', '影单', 'https://movie.example/')]),
    folder('1-15', '游戏', [
      bookmark('1-15-0', '商店', 'https://store.example/'),
      // 造几条同名不同址的页面：条目本来就靠完整网址区分（只显主机名会看不出差别）。
      bookmark('1-15-1', '攻略', 'https://a.example/x'),
      bookmark('1-15-2', '攻略', 'https://a.example/y')
    ]),
    folder('1-16', '旅行', [bookmark('1-16-0', '地图', 'https://map.example/')]),
    folder('1-17', '购物', [bookmark('1-17-0', '清单', 'https://shop.example/')]),
    marker('1-18', ''),
    folder('1-19', '待整理', []),
    folder('1-20', '归档 2025', [bookmark('1-20-0', '归档条目', 'https://archive.example/2025')]),
    folder('1-21', '归档 2024', [bookmark('1-21-0', '归档条目', 'https://archive.example/2024')]),
    folder('1-22', '临时', []),
    folder('1-23', '读书', [bookmark('1-23-0', '书单', 'https://book.example/')]),
    folder('1-24', '其他', [])
  ])

  // 「其他书签」里也放东西：它**不是**可收藏的层（收藏只认书签栏），
  // 所以这里的文件夹正是那条拒绝规则的测试对象。
  const other = folder('2', '其他书签', [
    folder('2-0', '别人的收藏', [
      bookmark('2-0-0', '别人存的一条', 'https://other.example/')
    ]),
    bookmark('2-1', '孤立书签', 'https://lone.example/')
  ])

  const mobile = folder('3', '移动设备书签', [])

  // `getTree()` 的返回：一个根（id `0`，无标题），其下固定三个子级。
  return [folder('0', '', [bar, other, mobile])]
}
