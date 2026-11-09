// MDX attribute values arrive as ESTree. Plans are data, not programs, so only
// literal shapes are accepted; anything that would need evaluation is rejected.

type EstreeNode = { type: string; [key: string]: any }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export class StaticPropError extends Error {}

export function evaluateStatic(node: EstreeNode): unknown {
  switch (node.type) {
    case 'Literal':
      if (node.regex || typeof node.bigint === 'string') throw new StaticPropError('regular expressions and bigints are not supported')
      return node.value
    case 'TemplateLiteral':
      if (node.expressions.length > 0) throw new StaticPropError('template literals cannot interpolate ${...}')
      return node.quasis.map((quasi: EstreeNode) => quasi.value.cooked ?? quasi.value.raw).join('')
    case 'ArrayExpression':
      return node.elements.map((element: EstreeNode | null) => {
        if (!element || element.type === 'SpreadElement') throw new StaticPropError('arrays cannot contain holes or spreads')
        return evaluateStatic(element)
      })
    case 'ObjectExpression': {
      const result: Record<string, unknown> = {}
      for (const property of node.properties as EstreeNode[]) {
        if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method) {
          throw new StaticPropError('objects may only contain plain key: value pairs')
        }
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
        if (typeof key !== 'string' && typeof key !== 'number') throw new StaticPropError('object keys must be names or strings')
        if (FORBIDDEN_KEYS.has(String(key))) throw new StaticPropError(`object key "${key}" is not allowed`)
        result[String(key)] = evaluateStatic(property.value)
      }
      return result
    }
    case 'UnaryExpression':
      if ((node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return node.operator === '-' ? -node.argument.value : node.argument.value
      }
      throw new StaticPropError(`operator ${node.operator} is not supported`)
    case 'Identifier':
      if (node.name === 'undefined') return undefined
      throw new StaticPropError(`variables are not supported (found "${node.name}")`)
    default:
      throw new StaticPropError(`${node.type} is not a static value`)
  }
}

type MdxAttribute = {
  type: string
  name?: string
  value?: null | string | { type: string; value: string; data?: { estree?: EstreeNode } }
}

export function staticProps(attributes: MdxAttribute[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const attribute of attributes) {
    if (attribute.type !== 'mdxJsxAttribute' || !attribute.name) throw new StaticPropError('spread attributes are not supported')
    if (FORBIDDEN_KEYS.has(attribute.name)) throw new StaticPropError(`prop "${attribute.name}" is not allowed`)
    const value = attribute.value
    if (value === null || value === undefined) {
      props[attribute.name] = true
    } else if (typeof value === 'string') {
      props[attribute.name] = value
    } else {
      const program = value.data?.estree
      const statement = program?.body?.[0]
      if (!program || program.body.length !== 1 || statement?.type !== 'ExpressionStatement') {
        throw new StaticPropError(`prop "${attribute.name}" must be a single static value`)
      }
      props[attribute.name] = evaluateStatic(statement.expression)
    }
  }
  return props
}
