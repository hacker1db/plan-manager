import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { BlockTarget } from "../lib/annotator"
import { colors, fonts } from "../theme"
import { Button, Label } from "./ui"

type Props = {
  target: BlockTarget | null
  existing: string | null
  onSave(note: string): void
  onDelete(): void
  onClose(): void
}

/** Bottom sheet for writing or editing the comment on one rendered block. */
export function CommentComposer({ target, existing, onSave, onDelete, onClose }: Props) {
  const insets = useSafeAreaInsets()
  const [text, setText] = useState("")
  useEffect(() => { setText(existing ?? "") }, [target, existing])

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
        <Pressable style={styles.fill} accessibilityLabel="Close comment" onPress={onClose} />
        {target ? (
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <Label color={colors.accent}>
              {existing ? "Edit comment" : "New comment"} · {target.kind}{target.heading ? ` under ${target.heading}` : ""}
            </Label>
            <Text style={styles.quote} numberOfLines={4}>{target.quote}</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              autoFocus
              multiline
              placeholder="What should change here?"
              placeholderTextColor={colors.faint}
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              accessibilityLabel="Comment"
              style={styles.input}
            />
            <View style={styles.actions}>
              <Button label="Save" variant="primary" disabled={!text.trim()} onPress={() => onSave(text)} />
              <Button label="Cancel" onPress={onClose} />
              {existing ? <View style={styles.push}><Button label="Delete" variant="danger" onPress={onDelete} /></View> : null}
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sheet: { gap: 12, paddingHorizontal: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.accent, backgroundColor: colors.ink },
  quote: { paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: colors.signal, fontFamily: fonts.body, fontSize: 14, lineHeight: 20, fontStyle: "italic", color: colors.muted },
  input: { minHeight: 96, maxHeight: 220, padding: 10, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panelSolid, color: colors.text, fontFamily: fonts.body, fontSize: 15, lineHeight: 21, textAlignVertical: "top" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  push: { marginLeft: "auto" },
})
