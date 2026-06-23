import WidgetKit
import SwiftUI

// MARK: - Shared Constants

private let quips = [
  // Confident humility
  "Ready. Willing. Reasonably able.",
  "At your service. Mostly.",
  "Standing by with alarming competence.",

  // Dry invitations
  "Your move.",
  "Say the word.",
  "Go ahead. I'll keep up.",
  "Tap when inspired. Or desperate. Both work.",

  // Self-aware
  "I'm all ears. Figuratively.",
  "Listening is my best skill. Allegedly.",
  "Thinking about your problems. By choice, oddly.",
  "Quietly competent. Loudly available.",

  // Cultural depth
  "The orchestra is tuned. Awaiting your downbeat.",
  "The brief is open. Counsel is ready.",
  "Ink is dry. The pen awaits your hand.",

  // Calm presence
  "Still here. Still sharp.",
  "Patient by design. Impatient by nature.",
  "Not going anywhere. Take your time.",
  "Idle, but make it dignified.",
]

private let indigo = Color(red: 99.0 / 255.0, green: 102.0 / 255.0, blue: 241.0 / 255.0)

private let appGroupSuite = "group.com.mindstone.rebel.mobile"
// 4h crash-recovery cap for stuck recording widget state.
private let RECORDING_TTL_SECONDS: TimeInterval = 4 * 60 * 60
// Empty-state data older than 12h is treated as stale.
private let STALENESS_THRESHOLD_SECONDS: TimeInterval = 12 * 60 * 60
// User-approved stale/failure hint copy.
private let STALE_EMPTY_HINT_COPY = "Nothing recent to show. Open Rebel to refresh."

// MARK: - Quip helper

private func quipForDate(_ date: Date, interval: TimeInterval = 30 * 60) -> String {
  let index = Int(date.timeIntervalSince1970 / interval) % quips.count
  return quips[index]
}

// MARK: - Voice Widget (existing .systemSmall)

struct VoiceWidgetEntry: TimelineEntry {
  let date: Date
  let quip: String
}

struct VoiceWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> VoiceWidgetEntry {
    VoiceWidgetEntry(date: Date(), quip: quips[0])
  }

  func getSnapshot(in context: Context, completion: @escaping (VoiceWidgetEntry) -> Void) {
    completion(VoiceWidgetEntry(date: Date(), quip: "I'm all ears. Figuratively."))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<VoiceWidgetEntry>) -> Void) {
    let now = Date()
    let interval: TimeInterval = 30 * 60
    var entries: [VoiceWidgetEntry] = []

    for i in 0..<24 {
      let entryDate = now.addingTimeInterval(interval * Double(i))
      entries.append(VoiceWidgetEntry(date: entryDate, quip: quipForDate(entryDate, interval: interval)))
    }

    completion(Timeline(entries: entries, policy: .after(entries.last!.date)))
  }
}

struct VoiceWidgetEntryView: View {
  let entry: VoiceWidgetEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Rebel")
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .foregroundStyle(indigo.opacity(0.9))

      Spacer()

      Text(entry.quip)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
        .lineLimit(3)
        .minimumScaleFactor(0.7)

      Spacer()

      HStack {
        Spacer()
        ZStack {
          Circle()
            .fill(indigo.opacity(0.15))
            .frame(width: 36, height: 36)
            .blur(radius: 10)
          Image(systemName: "mic.fill")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(indigo)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Rebel. \(entry.quip). Double-tap to start a conversation.")
    .containerBackground(for: .widget) {
      ZStack {
        Color.black
        RadialGradient(
          colors: [indigo.opacity(0.25), indigo.opacity(0.08), .clear],
          center: .bottomTrailing,
          startRadius: 0,
          endRadius: 200
        )
        RadialGradient(
          colors: [Color.white.opacity(0.03), .clear],
          center: .topLeading,
          startRadius: 0,
          endRadius: 140
        )
      }
    }
    .widgetURL(URL(string: "rebel://action/start-voice")!)
  }
}

struct RebelVoiceWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RebelVoiceWidget", provider: VoiceWidgetProvider()) { entry in
      VoiceWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Rebel Voice")
    .description("Talk to Rebel. It listens surprisingly well.")
    .supportedFamilies([.systemSmall])
  }
}

// MARK: - Action Widget (.systemMedium)

struct ActionItem: Identifiable {
  let id: String
  let title: String
  let urgent: Bool
}

struct ActionEntry: TimelineEntry {
  let date: Date
  let quip: String
  let actionItems: [ActionItem]
  let isRecording: Bool
  let recordingTitle: String?
  let lastUpdated: Date?
  let loadFailed: Bool
}

// MARK: App Groups data reading

private let recordingRed = Color(red: 0.9, green: 0.2, blue: 0.2)

private enum ActionItemsResult {
  case ok(items: [ActionItem])
  case loadFailed
  case neverWritten
}

private func parseEpochMilliseconds(_ rawValue: String?) -> Date? {
  guard let rawValue,
        !rawValue.isEmpty,
        let milliseconds = Double(rawValue),
        milliseconds > 0 else {
    return nil
  }
  // RN writes Date.now() timestamps (milliseconds); Date expects seconds.
  return Date(timeIntervalSince1970: milliseconds / 1000.0)
}

private func loadLastUpdatedAt(_ defaults: UserDefaults) -> Date? {
  parseEpochMilliseconds(defaults.string(forKey: "lastUpdated"))
}

private func loadLastUpdatedAt() -> Date? {
  guard let defaults = UserDefaults(suiteName: appGroupSuite) else {
    return nil
  }
  return loadLastUpdatedAt(defaults)
}

private func loadRecordingState() -> (isRecording: Bool, title: String?) {
  guard let defaults = UserDefaults(suiteName: appGroupSuite) else {
    return (false, nil)
  }
  let isRecording = defaults.string(forKey: "isRecording") == "true"
  let title = defaults.string(forKey: "recordingTitle")
  let normalizedTitle = title?.isEmpty == true ? nil : title

  if isRecording {
    let startedAt = parseEpochMilliseconds(defaults.string(forKey: "recordingStartedAt"))
    // TTL guard (4h): RN sets isRecording=true on start and false on stop,
    // but a crash/force-quit/OOM can leave it stuck. If the recording has
    // been active longer than any plausible meeting, ignore the flag.
    // Paired with the RN-side AppState reconciliation in useMeetingRecording.ts
    // (Stage 3). The 4h TTL is tight (all-day workshops will cut out) —
    // acceptable trade-off because RN reconciliation is the normal path;
    // the Swift TTL is only a crash-recovery backstop.
    let isStaleOrMissing = startedAt.map { Date().timeIntervalSince($0) > RECORDING_TTL_SECONDS } ?? true
    if isStaleOrMissing {
      return (false, nil)
    }
  }

  return (isRecording, normalizedTitle)
}

private func loadActionItems() -> ActionItemsResult {
  guard let defaults = UserDefaults(suiteName: appGroupSuite) else {
    return .loadFailed
  }

  guard defaults.object(forKey: "actionItems") != nil else {
    return .neverWritten
  }

  guard let data = defaults.data(forKey: "actionItems") else {
    return .loadFailed
  }

  guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    return .loadFailed
  }

  let items = parsed.compactMap { dict -> ActionItem? in
    guard let id = dict["id"] as? String,
          let title = dict["title"] as? String else {
      return nil
    }
    let urgent = dict["urgent"] as? Bool ?? false
    return ActionItem(id: id, title: title, urgent: urgent)
  }

  return .ok(items: items)
}

private func loadActionState() -> (items: [ActionItem], loadFailed: Bool) {
  switch loadActionItems() {
  case .ok(let items):
    return (items, false)
  case .neverWritten:
    return ([], false)
  case .loadFailed:
    return ([], true)
  }
}

// MARK: Timeline Provider

struct ActionWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> ActionEntry {
    ActionEntry(
      date: Date(),
      quip: quips[0],
      actionItems: [
        ActionItem(id: "1", title: "Review Q4 budget proposal", urgent: true),
        ActionItem(id: "2", title: "Send follow-up to Sarah", urgent: false),
      ],
      isRecording: false,
      recordingTitle: nil,
      lastUpdated: Date(),
      loadFailed: false
    )
  }

  func getSnapshot(in context: Context, completion: @escaping (ActionEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
      return
    }

    let actionState = loadActionState()
    let recording = loadRecordingState()
    completion(ActionEntry(
      date: Date(),
      quip: "I'm all ears. Figuratively.",
      actionItems: actionState.items,
      isRecording: recording.isRecording,
      recordingTitle: recording.title,
      lastUpdated: loadLastUpdatedAt(),
      loadFailed: actionState.loadFailed
    ))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<ActionEntry>) -> Void) {
    let now = Date()
    let actionState = loadActionState()
    let recording = loadRecordingState()
    let lastUpdated = loadLastUpdatedAt()

    if recording.isRecording {
      // During recording: single entry, refresh frequently to check state
      let entry = ActionEntry(
        date: now,
        quip: "",
        actionItems: actionState.items,
        isRecording: true,
        recordingTitle: recording.title,
        lastUpdated: lastUpdated,
        loadFailed: actionState.loadFailed
      )
      completion(Timeline(entries: [entry], policy: .after(now.addingTimeInterval(60))))
    } else {
      // Normal mode: quip rotation every 30 min
      let interval: TimeInterval = 30 * 60
      var entries: [ActionEntry] = []
      for i in 0..<24 {
        let entryDate = now.addingTimeInterval(interval * Double(i))
        entries.append(ActionEntry(
          date: entryDate,
          quip: quipForDate(entryDate, interval: interval),
          actionItems: actionState.items,
          isRecording: false,
          recordingTitle: nil,
          lastUpdated: lastUpdated,
          loadFailed: actionState.loadFailed
        ))
      }
      completion(Timeline(entries: entries, policy: .after(entries.last!.date)))
    }
  }
}

// MARK: Action Widget View

struct ActionWidgetEntryView: View {
  let entry: ActionEntry

  var body: some View {
    if entry.isRecording {
      recordingView
    } else {
      normalView
    }
  }

  // MARK: Recording takeover

  private var recordingView: some View {
    VStack(spacing: 0) {
      // Recording indicator
      HStack(spacing: 6) {
        Circle()
          .fill(recordingRed)
          .frame(width: 8, height: 8)
        Text("Recording")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(recordingRed)
        Spacer()
      }

      Spacer()

      // Title or generic label
      VStack(spacing: 4) {
        Image(systemName: "waveform")
          .font(.system(size: 28, weight: .medium))
          .foregroundStyle(recordingRed.opacity(0.8))
          .symbolEffect(.variableColor.iterative, options: .repeating)

        if let title = entry.recordingTitle, !title.isEmpty {
          Text(title)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white.opacity(0.85))
            .lineLimit(1)
            .truncationMode(.tail)
        } else {
          Text("Meeting in progress")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white.opacity(0.5))
        }
      }

      Spacer()

      // Stop button (full width for easy tapping)
      Link(destination: URL(string: "rebel://action/stop-meeting-recording")!) {
        HStack(spacing: 6) {
          Image(systemName: "stop.circle.fill")
            .font(.system(size: 14, weight: .medium))
          Text("Stop Recording")
            .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(recordingRed)
        .clipShape(RoundedRectangle(cornerRadius: 10))
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Rebel is recording. \(entry.recordingTitle ?? "Meeting in progress"). Double-tap to stop.")
    .containerBackground(for: .widget) {
      ZStack {
        Color.black
        RadialGradient(
          colors: [recordingRed.opacity(0.25), recordingRed.opacity(0.08), .clear],
          center: .bottomTrailing,
          startRadius: 0,
          endRadius: 250
        )
        RadialGradient(
          colors: [recordingRed.opacity(0.05), .clear],
          center: .topLeading,
          startRadius: 0,
          endRadius: 180
        )
      }
    }
  }

  // MARK: Normal state

  private var normalView: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Header: brand + quip
      HStack(alignment: .firstTextBaseline) {
        Text("Rebel")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(indigo.opacity(0.9))
        Spacer()
        Text(entry.quip)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.white.opacity(0.5))
          .lineLimit(1)
      }

      Spacer().frame(height: 8)

      // Action items or empty state
      if entry.actionItems.isEmpty {
        let isStale = entry.lastUpdated.map { Date().timeIntervalSince($0) > STALENESS_THRESHOLD_SECONDS } ?? false
        let showHint = entry.loadFailed || isStale
        Spacer()
        HStack {
          Spacer()
          Text(showHint ? STALE_EMPTY_HINT_COPY : "All clear. Nothing to act on.")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white.opacity(0.5))
          Spacer()
        }
        Spacer()
      } else {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(entry.actionItems.prefix(3)) { item in
            Link(destination: URL(string: "rebel://tasks/\(item.id)")!) {
              HStack(spacing: 6) {
                if item.urgent {
                  Circle()
                    .fill(Color.red)
                    .frame(width: 6, height: 6)
                } else {
                  Circle()
                    .fill(indigo.opacity(0.4))
                    .frame(width: 6, height: 6)
                }
                Text(item.title)
                  .font(.system(size: 13, weight: .regular))
                  .foregroundStyle(.white.opacity(0.85))
                  .lineLimit(1)
                  .truncationMode(.tail)
              }
            }
          }
        }
        Spacer()
      }

      // Bottom: two action buttons
      HStack(spacing: 12) {
        Link(destination: URL(string: "rebel://action/start-voice")!) {
          HStack(spacing: 4) {
            Image(systemName: "mic.fill")
              .font(.system(size: 12, weight: .medium))
            Text("Conversation")
              .font(.system(size: 12, weight: .semibold))
          }
          .foregroundStyle(indigo)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(indigo.opacity(0.12))
          .clipShape(Capsule())
        }

        Link(destination: URL(string: "rebel://action/start-meeting-recording")!) {
          HStack(spacing: 4) {
            Image(systemName: "record.circle")
              .font(.system(size: 12, weight: .medium))
            Text("Record")
              .font(.system(size: 12, weight: .semibold))
          }
          .foregroundStyle(indigo)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(indigo.opacity(0.12))
          .clipShape(Capsule())
        }

        Spacer()
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Rebel Actions. \(entry.quip). \(entry.actionItems.count) action items.")
    .containerBackground(for: .widget) {
      ZStack {
        Color.black
        RadialGradient(
          colors: [indigo.opacity(0.2), indigo.opacity(0.06), .clear],
          center: .bottomTrailing,
          startRadius: 0,
          endRadius: 250
        )
        RadialGradient(
          colors: [Color.white.opacity(0.03), .clear],
          center: .topLeading,
          startRadius: 0,
          endRadius: 180
        )
      }
    }
  }
}

struct RebelActionWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RebelActionWidget", provider: ActionWidgetProvider()) { entry in
      ActionWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Rebel Actions")
    .description("Your actions, conversations, and recording. All in one.")
    .supportedFamilies([.systemMedium])
  }
}

// MARK: - Widget Bundle

@main
struct RebelWidgetBundle: WidgetBundle {
  var body: some Widget {
    RebelVoiceWidget()
    RebelActionWidget()
  }
}
