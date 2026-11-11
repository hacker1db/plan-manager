package mdxrender

import "fmt"

// MDX attribute values arrive as ESTree. Plans are data, not programs, so only
// literal shapes are accepted; anything that would need evaluation is rejected.

var forbiddenKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

type staticPropError struct{ msg string }

func (e *staticPropError) Error() string { return e.msg }

func staticErr(format string, args ...any) error {
	return &staticPropError{msg: fmt.Sprintf(format, args...)}
}

func evaluateStatic(n *jsNode) (value, error) {
	// events-to-acorn unwraps one level of parentheses, so doubled
	// parentheses leave a ParenthesizedExpression behind.
	if n.parens >= 2 {
		return nil, staticErr("ParenthesizedExpression is not a static value")
	}
	switch n.Type {
	case "Literal":
		if n.Regex || n.Bigint {
			return nil, staticErr("regular expressions and bigints are not supported")
		}
		return n.Value, nil
	case "TemplateLiteral":
		if len(n.Exprs) > 0 {
			return nil, staticErr("template literals cannot interpolate ${...}")
		}
		s := ""
		for _, q := range n.Quasis {
			s += q
		}
		return s, nil
	case "ArrayExpression":
		a := &array{}
		for _, el := range n.Elements {
			if el == nil || el.Type == "SpreadElement" {
				return nil, staticErr("arrays cannot contain holes or spreads")
			}
			v, err := evaluateStatic(el)
			if err != nil {
				return nil, err
			}
			a.items = append(a.items, v)
		}
		return a, nil
	case "ObjectExpression":
		o := newObject()
		for _, prop := range n.Props {
			if prop.Type != "Property" || prop.Kind != "init" || prop.Computed || prop.Method {
				return nil, staticErr("objects may only contain plain key: value pairs")
			}
			var key string
			if prop.Key.Type == "Identifier" {
				key = prop.Key.Name
			} else {
				switch k := prop.Key.Value.(type) {
				case string:
					key = k
				case float64:
					key = numberString(k)
				default:
					return nil, staticErr("object keys must be names or strings")
				}
				if prop.Key.Bigint {
					return nil, staticErr("object keys must be names or strings")
				}
			}
			if forbiddenKeys[key] {
				return nil, staticErr("object key %q is not allowed", key)
			}
			v, err := evaluateStatic(prop.Value)
			if err != nil {
				return nil, err
			}
			o.set(key, v)
		}
		return o, nil
	case "UnaryExpression":
		if (n.Operator == "-" || n.Operator == "+") && n.Argument.Type == "Literal" && !n.Argument.Bigint && !n.Argument.Regex {
			if f, ok := n.Argument.Value.(float64); ok {
				if n.Operator == "-" {
					return -f, nil
				}
				return f, nil
			}
		}
		return nil, staticErr("operator %s is not supported", n.Operator)
	case "Identifier":
		if n.Name == "undefined" {
			return undefined, nil
		}
		return nil, staticErr("variables are not supported (found %q)", n.Name)
	}
	return nil, staticErr("%s is not a static value", n.Type)
}

func staticProps(attrs []jsxAttr) (*object, error) {
	props := newObject()
	for _, attr := range attrs {
		if attr.spread {
			return nil, staticErr("spread attributes are not supported")
		}
		if forbiddenKeys[attr.name] {
			return nil, staticErr("prop %q is not allowed", attr.name)
		}
		switch {
		case attr.expr != nil:
			v, err := evaluateStatic(attr.expr)
			if err != nil {
				return nil, err
			}
			props.set(attr.name, v)
		case attr.hasValue:
			props.set(attr.name, attr.value)
		default:
			props.set(attr.name, true)
		}
	}
	return props, nil
}
