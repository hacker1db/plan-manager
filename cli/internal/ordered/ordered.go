// Package ordered is a JSON/YAML object that keeps key order, so validated
// tracking data and command output serialize exactly like the JavaScript
// objects they were specified as.
package ordered

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Obj is an insertion-ordered object. Values are nil, bool, int64, float64,
// string, []any, or *Obj.
type Obj struct {
	keys []string
	vals map[string]any
}

func New() *Obj { return &Obj{vals: map[string]any{}} }

// Set adds key, or replaces its value in place like a JavaScript spread.
func (o *Obj) Set(key string, v any) *Obj {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
	return o
}

// SetIf sets key only when present is true; it mirrors optional fields that
// JavaScript drops when undefined.
func (o *Obj) SetIf(present bool, key string, v any) *Obj {
	if present {
		o.Set(key, v)
	}
	return o
}

func (o *Obj) Get(key string) (any, bool) {
	if o == nil || o.vals == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Str returns key's value when it is a string.
func (o *Obj) Str(key string) string {
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

func (o *Obj) Has(key string) bool { _, ok := o.Get(key); return ok }

func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	return o.keys
}

func (o *Obj) Len() int { return len(o.Keys()) }

// Merge sets every key of other on o, in other's order.
func (o *Obj) Merge(other *Obj) *Obj {
	for _, k := range other.Keys() {
		o.Set(k, other.vals[k])
	}
	return o
}

func (o *Obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.Keys() {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshal(o.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// JSON returns the compact JSON text of v, like JSON.stringify.
func JSON(v any) string {
	b, err := marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// DecodeJSON parses a JSON document into ordered values.
func DecodeJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected data after JSON value")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := New()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), v)
			}
			_, err := dec.Token()
			return o, err
		case '[':
			list := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := dec.Token()
			return list, err
		}
	case json.Number:
		return number(string(t)), nil
	}
	return tok, nil
}

func number(text string) any {
	if i, err := strconv.ParseInt(text, 10, 64); err == nil {
		return i
	}
	f, _ := strconv.ParseFloat(text, 64)
	if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
		return int64(f)
	}
	return f
}

// FromYAML converts a YAML node into ordered values.
func FromYAML(n *yaml.Node) any {
	if n == nil {
		return nil
	}
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil
		}
		return FromYAML(n.Content[0])
	case yaml.AliasNode:
		return FromYAML(n.Alias)
	case yaml.MappingNode:
		o := New()
		for i := 0; i+1 < len(n.Content); i += 2 {
			o.Set(n.Content[i].Value, FromYAML(n.Content[i+1]))
		}
		return o
	case yaml.SequenceNode:
		list := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			list = append(list, FromYAML(c))
		}
		return list
	}
	var v any
	if err := n.Decode(&v); err != nil {
		return n.Value
	}
	switch t := v.(type) {
	case int:
		return int64(t)
	case uint64:
		return float64(t)
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1<<53 && !strings.ContainsAny(n.Value, ".eE") {
			return int64(t)
		}
		return t
	case time.Time:
		// An unquoted timestamp is still a timestamp string to JavaScript readers.
		return n.Value
	}
	return v
}

// ToYAML converts ordered values into a block-style YAML node.
func ToYAML(v any) *yaml.Node {
	switch t := v.(type) {
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(t)}
	case int64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(t, 10)}
	case int:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(t)}
	case float64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: strconv.FormatFloat(t, 'g', -1, 64)}
	case string:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}
	case []any:
		n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		if len(t) == 0 {
			n.Style = yaml.FlowStyle
		}
		for _, item := range t {
			n.Content = append(n.Content, ToYAML(item))
		}
		return n
	case []string:
		list := make([]any, len(t))
		for i, s := range t {
			list[i] = s
		}
		return ToYAML(list)
	case *Obj:
		n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		if t.Len() == 0 {
			n.Style = yaml.FlowStyle
		}
		for _, k := range t.Keys() {
			n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k}, ToYAML(t.vals[k]))
		}
		return n
	}
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(v)}
}
