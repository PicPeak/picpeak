import type { ExtractedKey, Plugin } from 'i18next-cli'
import * as ts from 'typescript'
import { vol } from 'memfs'
import * as path from 'path'

// based on https://github.com/i18next/i18next-cli/blob/49188621ae5534d940c7cc86eca1e3ece99506e7/test/plugin.typescript.test.ts

// --- HELPER FUNCTIONS FOR PLUGIN ---
function isTranslationFunction (node: ts.CallExpression): boolean {
  const expr = node.expression
  // Matches t('...')
  if (ts.isIdentifier(expr) && expr.text === 't') return true

  // Matches i18n.t('...')
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 't') return true

  return false
}

function extractStringsFromType (type: ts.Type): string[] {
  if (type.isStringLiteral()) {
    return [type.value]
  }
  if (type.isUnion()) {
    return type.types.flatMap(t => extractStringsFromType(t))
  }
  if (type.isIntersection()) {
    return type.types.flatMap(t => extractStringsFromType(t))
  }
  return []
}

export function typescriptPlugin (
  entryPoints: string[],
  options: { defaultNS?: string } = {}
): Plugin {
  const defaultNS = options.defaultNS

  return {
    name: 'typescript-resolver',
    async onEnd (keys: Map<string, ExtractedKey>) {
      // 1. Setup Compiler Options
      const compilerOptions: ts.CompilerOptions = {
        allowJs: true,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true
      }

      // 2. Create a custom CompilerHost that reads from memfs (vol)
      const host = ts.createCompilerHost(compilerOptions)
      const originalReadFile = host.readFile
      const originalFileExists = host.fileExists

      host.readFile = (fileName: string) => {
        if (vol.existsSync(fileName)) {
          return vol.readFileSync(fileName, 'utf-8') as string
        }
        return originalReadFile(fileName)
      }

      host.fileExists = (fileName: string) => {
        if (vol.existsSync(fileName)) return true
        return originalFileExists(fileName)
      }

      // Override module resolution to look in memfs
      host.resolveModuleNameLiterals = (moduleLiterals, containingFile, redirectedReference, options, containingSourceFile, reusedNames) => {
        return moduleLiterals.map(moduleLiteral => {
          const moduleName = moduleLiteral.text
          // Simple resolution for test: resolve relative paths against the containing file's directory
          if (moduleName.startsWith('.')) {
            const dir = path.dirname(containingFile)
            const candidates: [string, ts.Extension][] = [
              [path.join(dir, moduleName + '.tsx'), ts.Extension.Tsx],
              [path.join(dir, moduleName + '.ts'), ts.Extension.Ts],
            ]
            for (const [resolvedPath, ext] of candidates) {
              if (vol.existsSync(resolvedPath)) {
                return {
                  resolvedModule: {
                    resolvedFileName: resolvedPath,
                    extension: ext,
                    isExternalLibraryImport: false
                  }
                }
              }
            }
          }
          // Fallback to standard resolution (for node_modules etc)
          return ts.resolveModuleName(moduleName, containingFile, options, host)
        })
      }

      // 3. Create Program
      const program = ts.createProgram(entryPoints, compilerOptions, host)
      const checker = program.getTypeChecker()

      // 4. Visit AST
      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue
        ts.forEachChild(sourceFile, node => { visit(node, undefined) })
      }

      // Extract namespace from useTranslation call
      function getUseTranslationNamespace (node: ts.CallExpression): string | undefined {
        const expr = node.expression
        if (ts.isIdentifier(expr) && expr.text === 'useTranslation') {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteral(arg)) {
            return arg.text
          }
          // Handle array of namespaces: useTranslation(['ns1', 'ns2']) - use the first one
          if (arg && ts.isArrayLiteralExpression(arg)) {
            const firstElement = arg.elements[0]
            if (firstElement && ts.isStringLiteral(firstElement)) {
              return firstElement.text
            }
          }
        }
        return undefined
      }

      function visit (node: ts.Node, scopeNs: string | undefined) {
        // Track useTranslation namespace in current scope
        let currentScopeNs = scopeNs

        // Check if this is a function with useTranslation
        if (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) {
          const body = 'body' in node ? node.body : undefined
          if (body) {
            // Look for useTranslation in this function
            const searchForUseTranslation = (n: ts.Node): string | undefined => {
              if (ts.isVariableDeclaration(n) && n.initializer &&
                ts.isCallExpression(n.initializer)) {
                const ns = getUseTranslationNamespace(n.initializer)
                if (ns) return ns
              }
              if (ts.isCallExpression(n)) {
                const ns = getUseTranslationNamespace(n)
                if (ns) return ns
              }
              let result: string | undefined
              ts.forEachChild(n, child => {
                if (!result) result = searchForUseTranslation(child)
              })
              return result
            }
            currentScopeNs = searchForUseTranslation(body) ?? scopeNs
          }
        }

        if (ts.isCallExpression(node) && isTranslationFunction(node)) {
          const arg = node.arguments[0]
          if (arg) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              ts.forEachChild(node, child => { visit(child, currentScopeNs) })
              return
            }

            let values: string[] = []

            // Handle function arguments (e.g. t(() => ...)) by checking return type
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
              const signature = checker.getSignatureFromDeclaration(arg)
              if (signature) {
                const returnType = signature.getReturnType()
                values = extractStringsFromType(returnType)
              }
            } else {
              // Try standard type resolution first
              const type = checker.getTypeAtLocation(arg)
              values = extractStringsFromType(type)
            }

            // Fallback: If type resolution failed (generic string) but it's a TemplateExpression,
            // try to manually resolve the parts. This helps in test environments where full type inference is flaky.
            if (values.length === 0 && ts.isTemplateExpression(arg)) {
              const head = arg.head.text
              // Only handle simple case: `prefix.${var}`
              if (arg.templateSpans.length === 1) {
                const span = arg.templateSpans[0]
                const spanType = checker.getTypeAtLocation(span.expression)
                const spanValues = extractStringsFromType(spanType)

                if (spanValues.length > 0) {
                  values = spanValues.map(v => head + v + span.literal.text)
                }
              }
            }

            // Extract namespace from options (second argument)
            let optionsNs: string | undefined
            const optionsArg = node.arguments[1]
            if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
              const nsProp = optionsArg.properties.find(
                p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'ns'
              )
              if (nsProp && ts.isPropertyAssignment(nsProp)) {
                if (ts.isStringLiteral(nsProp.initializer)) {
                  optionsNs = nsProp.initializer.text
                }
              }
            }

            values.forEach(val => {
              let key = val
              // Priority: 1. options ns, 2. key contains ns, 3. useTranslation ns, 4. default 'all'
              let ns = optionsNs

              // Check if key contains namespace separator (e.g., "namespace:key")
              const separatorIndex = val.indexOf(':')
              if (separatorIndex > 0) {
                ns = val.substring(0, separatorIndex)
                key = val.substring(separatorIndex + 1)
              }

              let uniqueKey = key

              // Fallback to useTranslation namespace or default
              if (!ns) {
                if(currentScopeNs) {
                  ns = currentScopeNs
                } else if (defaultNS) {
                  ns = defaultNS
                }
              }
              if (ns) {
                uniqueKey = `${ns}:${key}`
              }

              if (!keys.has(uniqueKey)) {
                keys.set(uniqueKey, {
                  key,
                  defaultValue: key,
                  nsIsImplicit: !optionsNs && !val.includes(':') && !currentScopeNs,
                })
              }
            })
          }
        }
        ts.forEachChild(node, child => { visit(child, currentScopeNs) })
      }
    }
  }
}
