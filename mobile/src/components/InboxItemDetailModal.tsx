// mobile/src/components/InboxItemDetailModal.tsx
// Extracted from mobile/app/(tabs)/inbox.tsx — detail modal for inbox items.

import { useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  resolveInboxCtaLabel,
  deriveContextPlaceholder,
  getProcessingQuip,
  formatRelativeTime,
  type InboxItem,
} from '@rebel/cloud-client';
import {
  derivePriorityLevel,
  cyclePriority,
  priorityToQuadrant,
  getPriorityLabel,
  getScheduleDueBy,
  computeTemporalBoundaries,
  TEMPORAL_GROUP_META,
  type PriorityLevel,
  type ConcreteTemporalGroup,
} from '@rebel/shared';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Markdown from '@ronradtke/react-native-markdown-display';
import Animated from 'react-native-reanimated';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { createMarkdownStyles } from '../theme/markdownStyles';
import { hapticLight, hapticMedium } from '../utils/haptics';
import { Pressable } from './Pressable';
import { useMobileVoiceRecording } from '../hooks/useMobileVoiceRecording';
import { usePulseAnimation } from '../hooks/usePulseAnimation';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEDULE_GROUPS: ConcreteTemporalGroup[] = ['due-today', 'due-this-week', 'upcoming'];

function getPriorityBadgeStyle(level: PriorityLevel, styles: ReturnType<typeof createStyles>) {
  switch (level) {
    case 'urgent': return styles.badgeUrgent;
    case 'high': return styles.badgeHigh;
    case 'medium': return styles.badgeMedium;
    case 'low': return null;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    // Shell
    modalOverlay: { flex: 1, justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%', flex: 0 },
    modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
    // Compact header — title + badge + timestamp only
    modalHeader: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    modalTitle: { ...typography.headline, fontSize: 18, fontWeight: '700', color: colors.textPrimary },
    modalMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
    modalTimestamp: { ...typography.caption, fontSize: 13, color: colors.textTertiary },
    // Scroll body
    modalBody: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
    modalSection: { marginBottom: 16 },
    modalSectionTitle: { ...typography.overline, fontSize: 12, fontWeight: '700', color: colors.textTertiary, letterSpacing: 1.5, marginBottom: 8 },
    modalMarkdownWrap: { backgroundColor: colors.surface, borderRadius: 12, padding: 12 },
    clarifyingWrap: { backgroundColor: colors.accentLight, borderRadius: 12, padding: 12 },
    draftWrap: { backgroundColor: colors.successLight, borderRadius: 12, padding: 12 },
    referenceChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8 },
    referenceChipText: { ...typography.bodySmall, fontSize: 13, color: colors.textSecondary },
    referencesRow: { flexDirection: 'row', flexWrap: 'wrap' },
    // Badge
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.surface },
    badgeUrgent: { backgroundColor: colors.errorLight },
    badgeHigh: { backgroundColor: colors.accentMuted },
    badgeMedium: { backgroundColor: colors.warningLight },
    badgeText: { ...typography.overline, fontSize: 11, fontWeight: '700', color: colors.textSecondary, letterSpacing: 1.5 },
    // Schedule chips (now in scroll body)
    scheduleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    scheduleChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    scheduleChipActive: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
    scheduleChipText: { ...typography.caption, fontWeight: '600', color: colors.textSecondary },
    scheduleChipTextActive: { ...typography.caption, fontWeight: '600', color: colors.accent },
    // Tag chips (now in scroll body)
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    tagChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    tagChipText: { ...typography.caption, color: colors.textSecondary },
    tagAddChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' as const },
    tagInput: { ...typography.caption, color: colors.textPrimary, minWidth: 60, paddingVertical: 0, paddingHorizontal: 0 },
    // Fixed footer: input row + action row
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.background },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
    contextInput: { ...typography.body, flex: 1, backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, color: colors.textPrimary, borderWidth: 1, borderColor: colors.border, minHeight: 40, maxHeight: 100 },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
    // Action buttons
    actionIconBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
    doneBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent + '15' },
    ctaButton: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18, alignItems: 'center' },
    ctaButtonText: { ...typography.body, fontSize: 14, fontWeight: '700', color: '#fff' },
    reviseButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
    reviseButtonText: { ...typography.body, fontSize: 14, fontWeight: '700', color: colors.textPrimary },
    executingBar: { flex: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 10 },
    // Auto-done toggle
    autoDoneContainer: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    autoDoneTrack: { width: 32, height: 18, borderRadius: 9, backgroundColor: colors.border, justifyContent: 'center', paddingHorizontal: 2 },
    autoDoneTrackOn: { backgroundColor: colors.accent },
    autoDoneThumb: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#fff' },
    autoDoneLabel: { ...typography.caption, fontSize: 11, color: colors.textTertiary },
    // Mic button
    micButton: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    micButtonRecording: { backgroundColor: colors.errorLight, borderColor: '#ef4444' },
    voiceError: { paddingHorizontal: 16, paddingVertical: 2 },
    voiceErrorText: { ...typography.caption, color: colors.error },
    transcribingRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingHorizontal: 16, paddingVertical: 2 },
    transcribingText: { ...typography.caption, color: colors.textTertiary },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface InboxItemDetailModalProps {
  item: InboxItem;
  onClose: () => void;
  onExecute: (id: string, context: string | undefined, autoDone: boolean) => void;
  onDelete: (id: string) => void;
  onSetPriority: (id: string, urgent: boolean, important: boolean) => void;
  onSnooze: (id: string, dueBy: number | null) => void;
  onSetTags: (id: string, tags: string[]) => void;
  onDone: (id: string) => void;
}

export function InboxItemDetailModal({
  item,
  onClose,
  onExecute,
  onDelete,
  onSetPriority,
  onSnooze,
  onSetTags,
  onDone,
}: InboxItemDetailModalProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [context, setContext] = useState('');
  const [autoDone, setAutoDone] = useState(false);

  // Reset auto-done toggle when item changes
  useEffect(() => {
    setAutoDone(false);
  }, [item.id]);

  // Tag editing state
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState('');

  const isExecuting = !!item.executingSessionId;
  const ctaLabel = resolveInboxCtaLabel(item);
  const hasText = !!item.text?.trim();
  const hasClarifying = !!item.clarifyingQuestion?.trim();
  const hasDraft = !!item.draft?.trim();
  const hasReferences = item.references?.length > 0;
  const isMeetingRecording = useActiveRecordingStore((s) => s.isActive);

  // Stage 2: Priority
  const priorityLevel = useMemo(() => derivePriorityLevel(item), [item]);
  const priorityLabel = useMemo(() => getPriorityLabel(priorityLevel), [priorityLevel]);

  // Stage 3: Schedule — determine active chip from item.dueBy
  const activeScheduleGroup = useMemo<ConcreteTemporalGroup | null>(() => {
    if (item.dueBy == null) return null;
    const b = computeTemporalBoundaries();
    if (item.dueBy < b.todayEndMs) return 'due-today';
    if (item.dueBy < b.weekEndMs) return 'due-this-week';
    return 'upcoming';
  }, [item.dueBy]);

  // Voice recording for context field
  const handleVoiceTranscript = useCallback((text: string) => {
    hapticLight();
    setContext((prev) => (prev ? prev + ' ' + text : text));
  }, []);

  const {
    isRecording, isTranscribing, toggleRecording,
    error: voiceError,
  } = useMobileVoiceRecording(handleVoiceTranscript);

  const pulseStyle = usePulseAnimation(isRecording);

  const handleExecute = useCallback(() => {
    onExecute(item.id, context.trim() || undefined, autoDone);
    setContext('');
    onClose();
  }, [item.id, context, autoDone, onExecute, onClose]);

  // Stage 4: Draft revise handler
  const handleRevise = useCallback(() => {
    onExecute(item.id, context.trim() || 'Please help me revise this draft', autoDone);
    setContext('');
    onClose();
  }, [item.id, context, autoDone, onExecute, onClose]);

  const handleDelete = useCallback(() => {
    Alert.alert('Delete item', 'Remove this from actions?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { onDelete(item.id); onClose(); } },
    ]);
  }, [item.id, onDelete, onClose]);

  // Stage 2: Cycle priority on badge tap
  const handleCyclePriority = useCallback(() => {
    hapticLight();
    const nextLevel = cyclePriority(priorityLevel);
    const { urgent, important } = priorityToQuadrant(nextLevel);
    onSetPriority(item.id, urgent, important);
  }, [item.id, priorityLevel, onSetPriority]);

  // Stage 3: Schedule chip tap
  const handleSchedule = useCallback((group: ConcreteTemporalGroup | null) => {
    hapticLight();
    const dueBy = group != null ? getScheduleDueBy(group) : null;
    onSnooze(item.id, dueBy);
  }, [item.id, onSnooze]);

  // Stage 5: Tag editing
  const handleRemoveTag = useCallback((tag: string) => {
    hapticLight();
    onSetTags(item.id, (item.tags || []).filter(t => t !== tag));
  }, [item.id, item.tags, onSetTags]);

  const handleAddTag = useCallback(() => {
    const trimmed = newTagText.trim();
    if (!trimmed || trimmed.length > 30) return;
    if ((item.tags || []).includes(trimmed)) {
      setNewTagText('');
      return;
    }
    hapticLight();
    onSetTags(item.id, [...(item.tags || []), trimmed]);
    setNewTagText('');
    setIsAddingTag(false);
    Keyboard.dismiss();
  }, [item.id, item.tags, newTagText, onSetTags]);

  // Stage 6: Done handler
  const handleDone = useCallback(() => {
    onDone(item.id);
  }, [item.id, onDone]);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} />
        <TouchableOpacity
          testID="inbox-detail-close-overlay"
          style={{ flex: 1 }}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />

          {/* Compact header: title + badge + timestamp */}
          <View style={s.modalHeader}>
            <Text style={s.modalTitle} numberOfLines={2}>{item.title}</Text>
            <View style={s.modalMeta}>
              <TouchableOpacity
                testID="inbox-detail-priority-badge"
                onPress={handleCyclePriority}
                activeOpacity={0.7}
                disabled={isExecuting}
              >
                <View style={[s.badge, getPriorityBadgeStyle(priorityLevel, s)]}>
                  <Text style={s.badgeText}>{priorityLabel}</Text>
                </View>
              </TouchableOpacity>
              <Text style={s.modalTimestamp}>{formatRelativeTime(item.addedAt)}</Text>
            </View>
          </View>

          {/* Scrollable body: tags, schedule, content sections */}
          <ScrollView style={s.modalBody} showsVerticalScrollIndicator={false}>
            {/* Tags (in scroll) */}
            {((item.tags && item.tags.length > 0) || !isExecuting) && (
              <View style={s.modalSection}>
                <View style={s.tagRow}>
                  {(item.tags || []).map((tag) => (
                    <View key={tag} style={s.tagChip}>
                      <Text style={s.tagChipText}>{tag}</Text>
                      {!isExecuting && (
                        <TouchableOpacity
                          testID={`inbox-detail-tag-remove-${tag}`}
                          onPress={() => handleRemoveTag(tag)}
                          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                        >
                          <Feather name="x" size={12} color={colors.textTertiary} />
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}
                  {!isExecuting && (
                    isAddingTag ? (
                      <View style={s.tagChip}>
                        <TextInput
                          testID="inbox-detail-tag-input"
                          style={s.tagInput}
                          value={newTagText}
                          onChangeText={setNewTagText}
                          maxLength={30}
                          returnKeyType="done"
                          autoFocus
                          onSubmitEditing={handleAddTag}
                          onBlur={() => { setIsAddingTag(false); setNewTagText(''); }}
                          placeholder="tag…"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    ) : (
                      <TouchableOpacity
                        testID="inbox-detail-tag-add"
                        style={s.tagAddChip}
                        onPress={() => setIsAddingTag(true)}
                        activeOpacity={0.7}
                      >
                        <Feather name="plus" size={12} color={colors.textTertiary} />
                      </TouchableOpacity>
                    )
                  )}
                </View>
              </View>
            )}

            {/* Schedule chips (in scroll) */}
            {!isExecuting && (
              <View style={s.modalSection}>
                <View style={s.scheduleRow}>
                  {SCHEDULE_GROUPS.map((group) => {
                    const isActive = activeScheduleGroup === group;
                    return (
                      <TouchableOpacity
                        key={group}
                        testID={`inbox-detail-schedule-${group}`}
                        style={[s.scheduleChip, isActive && s.scheduleChipActive]}
                        onPress={() => handleSchedule(group)}
                        activeOpacity={0.7}
                      >
                        <Text style={isActive ? s.scheduleChipTextActive : s.scheduleChipText}>
                          {TEMPORAL_GROUP_META[group].label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  {item.dueBy != null && (
                    <TouchableOpacity
                      testID="inbox-detail-schedule-clear"
                      style={s.scheduleChip}
                      onPress={() => handleSchedule(null)}
                      activeOpacity={0.7}
                    >
                      <Text style={s.scheduleChipText}>Clear</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {hasText && (
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>DETAILS</Text>
                <View style={s.modalMarkdownWrap}>
                  <Markdown style={mdStyles}>{item.text}</Markdown>
                </View>
              </View>
            )}

            {hasClarifying && (
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>CLARIFYING QUESTION</Text>
                <View style={s.clarifyingWrap}>
                  <Markdown style={mdStyles}>{item.clarifyingQuestion!}</Markdown>
                </View>
              </View>
            )}

            {hasDraft && (
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>DRAFT</Text>
                <View style={s.draftWrap}>
                  <Markdown style={mdStyles}>{item.draft!}</Markdown>
                </View>
              </View>
            )}

            {hasReferences && (
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>REFERENCES</Text>
                <View style={s.referencesRow}>
                  {item.references.map((ref, i) => (
                    <View key={`ref-${i}`} style={s.referenceChip}>
                      <Feather
                        name={ref.kind === 'workspace' ? 'folder' : ref.kind === 'url' ? 'external-link' : ref.kind === 'email' ? 'mail' : 'file'}
                        size={12}
                        color={colors.textSecondary}
                      />
                      <Text style={s.referenceChipText} numberOfLines={1}>
                        {ref.label || (ref.kind === 'workspace' ? ref.path?.split('/').pop() : ref.kind === 'url' ? ref.url : ref.kind === 'email' ? ref.threadId : 'Reference') || 'Reference'}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>

          {/* Fixed footer: input row + action row */}
          <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
            {/* Input row — always visible when not executing */}
            {!isExecuting && (
              <>
                <View style={s.inputRow}>
                  <TextInput
                    testID="inbox-detail-context-input"
                    style={s.contextInput}
                    placeholder={deriveContextPlaceholder(item)}
                    placeholderTextColor={colors.textTertiary}
                    value={context}
                    onChangeText={setContext}
                    maxLength={2000}
                    multiline
                    returnKeyType="default"
                    editable={!isRecording}
                  />
                  <Animated.View style={pulseStyle}>
                    <TouchableOpacity
                      testID="inbox-detail-mic-button"
                      style={[s.micButton, isRecording && s.micButtonRecording, isMeetingRecording && { opacity: 0.4 }]}
                      onPress={() => { hapticMedium(); toggleRecording(); }}
                      activeOpacity={0.7}
                      disabled={isMeetingRecording}
                      accessibilityLabel={isMeetingRecording ? 'Voice recording disabled — meeting recording in progress' : isRecording ? 'Stop recording' : 'Record voice context'}
                    >
                      <Feather
                        name="mic"
                        size={18}
                        color={isRecording ? '#ef4444' : isMeetingRecording ? colors.textTertiary : colors.textSecondary}
                      />
                    </TouchableOpacity>
                  </Animated.View>
                </View>
                {voiceError && (
                  <View testID="inbox-detail-voice-error" style={s.voiceError}>
                    <Text style={s.voiceErrorText}>{voiceError}</Text>
                  </View>
                )}
                {isTranscribing && (
                  <View testID="inbox-detail-transcribing-indicator" style={s.transcribingRow}>
                    <ActivityIndicator size="small" color={colors.textTertiary} />
                    <Text style={s.transcribingText}>Transcribing…</Text>
                  </View>
                )}
              </>
            )}

            {/* Action row */}
            <View style={s.actionRow}>
              <Pressable
                testID="inbox-detail-done-button"
                style={[s.doneBtn, isExecuting && { opacity: 0.4 }]}
                onPress={handleDone}
                disabled={isExecuting}
              >
                <Feather name="check-circle" size={16} color={colors.accent} />
              </Pressable>
              <Pressable
                testID="inbox-detail-delete-button"
                style={s.actionIconBtn}
                onPress={handleDelete}
              >
                <Feather name="trash-2" size={16} color={colors.error} />
              </Pressable>
              {isExecuting ? (
                <View style={s.executingBar}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={s.ctaButtonText}>{getProcessingQuip()}</Text>
                </View>
              ) : (
                <>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    testID="inbox-detail-auto-done-toggle"
                    style={s.autoDoneContainer}
                    onPress={() => { hapticLight(); setAutoDone((prev) => !prev); }}
                    activeOpacity={0.7}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: autoDone }}
                    accessibilityLabel="Auto-mark done"
                  >
                    <View style={[s.autoDoneTrack, autoDone && s.autoDoneTrackOn]}>
                      <View style={[s.autoDoneThumb, { alignSelf: autoDone ? 'flex-end' : 'flex-start' }]} />
                    </View>
                    <Text style={s.autoDoneLabel}>Auto-done</Text>
                  </TouchableOpacity>
                  {hasDraft ? (
                    <>
                      <Pressable
                        testID="inbox-detail-revise-button"
                        style={s.reviseButton}
                        onPress={handleRevise}
                      >
                        <Text style={s.reviseButtonText}>Revise</Text>
                      </Pressable>
                      <Pressable
                        testID="inbox-detail-execute-button"
                        style={s.ctaButton}
                        onPress={handleExecute}
                      >
                        <Text style={s.ctaButtonText}>Send</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      testID="inbox-detail-execute-button"
                      style={s.ctaButton}
                      onPress={handleExecute}
                    >
                      <Text style={s.ctaButtonText}>{ctaLabel}</Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
