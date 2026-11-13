import { shouldLoadInReader } from "../src/lib/reader-policy"

test("reader loads only its own document and hands permitted links to the system", () => {
  const opened: string[] = []
  const open = (url: string) => { opened.push(url) }
  expect(shouldLoadInReader({ url: "about:blank" }, open)).toBe(true)
  for (const url of ["https://example.com", "http://example.com", "mailto:a@example.com", "javascript:alert(1)", "file:///etc/passwd", "planmanager://x"]) {
    expect(shouldLoadInReader({ url }, open)).toBe(false)
  }
  expect(opened).toEqual(["https://example.com", "http://example.com", "mailto:a@example.com"])
})
