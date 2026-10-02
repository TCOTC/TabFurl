/**
 * 让 `node --test` 能直接加载 TypeScript 源码的解析钩子。
 *
 * 项目用 `moduleResolution: "bundler"`，源码里的相对导入不写扩展名
 * （`import {x} from './naming'`）——打包器能补全，Node 的 ESM 解析器不能，
 * 会报 ERR_MODULE_NOT_FOUND。这里只给「无扩展名的相对导入」补上 `.ts`。
 *
 * 仅用于测试，不参与构建产物。
 */
import {registerHooks} from 'node:module'

const RELATIVE = /^\.\.?\//
const HAS_EXTENSION = /\.[a-z0-9]+$/i

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        // 不是 .ts（目录、别的扩展名），按原样交给默认解析器处理。
      }
    }
    return nextResolve(specifier, context)
  }
})
