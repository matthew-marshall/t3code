import { LegendList } from "@legendapp/list/react-native";
import { type StaticScreenProps, useFocusEffect, useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { shareAsync } from "expo-sharing";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ListRow } from "../../components/ListRow";
import { cn } from "../../lib/cn";
import {
  type DictationRecord,
  parseVoiceLog,
  summarizeVoiceSession,
  type VoiceSessionSummary,
  type VoiceTimelineEntry,
  voiceTimeline,
} from "../voice-agent/voiceSessionHistory";
import {
  deleteDictation,
  dictationHistory,
  readVoiceSessionLog,
  voiceSessionLogs,
} from "../voice-agent/voiceSessionLog";

const when = (at: string) =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

const minutes = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/** Copies to the clipboard, and says so for a moment. */
function CopyButton(props: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label ?? "Copy"}
      className="min-h-9 flex-row items-center gap-1.5 self-start rounded-full bg-subtle px-3 active:opacity-60"
      onPress={() => void Clipboard.setStringAsync(props.text).then(() => setCopied(true))}
    >
      <SymbolView
        name={copied ? "checkmark" : "doc.on.doc"}
        size={14}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <Text className="text-sm text-foreground">{copied ? "Copied" : (props.label ?? "Copy")}</Text>
    </Pressable>
  );
}

function Card(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <View
      className={cn("gap-2 rounded-[20px] border-continuous bg-grouped-card p-4", props.className)}
    >
      {props.children}
    </View>
  );
}

/** LegendList lays out its items itself, so spacing is padding rather than a gap. */
function useListInsets() {
  const insets = useSafeAreaInsets();
  return { paddingHorizontal: 20, paddingTop: 16, paddingBottom: Math.max(insets.bottom, 18) + 18 };
}

function Empty(props: { readonly text: string }) {
  return (
    <View className="items-center px-6 py-12">
      <Text className="text-center text-base text-foreground-muted">{props.text}</Text>
    </View>
  );
}

/** Every dictation, newest first, to read, copy or delete; kept after the session logs rotate. */
export function SettingsVoiceDictationsRouteScreen() {
  const navigation = useNavigation();
  const openSession = (name: string) =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsVoiceSession", params: { name } },
    });
  const [dictations, setDictations] = useState<ReadonlyArray<DictationRecord> | null>(null);
  // Session logs rotate out, so a dictation links to its session only while that is kept.
  const [keptLogs, setKeptLogs] = useState<ReadonlySet<string>>(new Set());
  const reload = useCallback(() => {
    setKeptLogs(new Set(voiceSessionLogs().map((log) => log.name)));
    void dictationHistory()
      .then(setDictations)
      .catch(() => setDictations([]));
  }, []);
  useFocusEffect(reload);
  const contentStyle = useListInsets();

  const remove = (dictation: DictationRecord) =>
    Alert.alert("Delete this dictation?", "It cannot be recovered afterwards.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void deleteDictation(dictation.at).then(reload),
      },
    ]);

  return (
    <LegendList
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={contentStyle}
      data={dictations ?? []}
      estimatedItemSize={160}
      keyExtractor={(dictation) => dictation.at}
      ListHeaderComponent={
        <View className="mb-3 overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
          <ListRow
            icon="bubble.left.and.bubble.right"
            label="Sessions and tool calls"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsVoiceSessions" },
              })
            }
          />
        </View>
      }
      ListEmptyComponent={
        dictations === null ? null : (
          <Empty text="No dictations yet. Ask the voice agent to start one." />
        )
      }
      renderItem={({ item }) => (
        <Card className="mb-3">
          <Text className="text-sm text-foreground-muted">
            {when(item.at)} · {minutes(item.seconds)}
          </Text>
          <Text selectable className="text-base leading-normal text-foreground">
            {item.text}
          </Text>
          <View className="flex-row gap-2 pt-1">
            <CopyButton text={item.text} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete"
              className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-60"
              onPress={() => remove(item)}
            >
              <SymbolView
                name="trash"
                size={14}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
              <Text className="text-sm text-danger-foreground">Delete</Text>
            </Pressable>
            {item.sessionLog !== null && keptLogs.has(item.sessionLog) ? (
              <Pressable
                accessibilityRole="button"
                className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-60"
                onPress={() => openSession(item.sessionLog ?? "")}
              >
                <Text className="text-sm text-foreground">Session</Text>
                <SymbolView
                  name="chevron.right"
                  size={11}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        </Card>
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}

interface SessionListItem {
  readonly name: string;
  readonly summary: VoiceSessionSummary;
}

const sessionDetail = (summary: VoiceSessionSummary) => {
  const seconds = Math.round(
    (new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000,
  );
  return [
    minutes(Math.max(seconds, 0)),
    summary.dictations > 0 ? `${summary.dictations} dictated` : null,
    summary.tools > 0 ? `${summary.tools} tool calls` : null,
    summary.errors > 0 ? "ended with an error" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** The voice sessions still logged, newest first. */
export function SettingsVoiceSessionsRouteScreen() {
  const navigation = useNavigation();
  const [sessions, setSessions] = useState<ReadonlyArray<SessionListItem> | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all(
        voiceSessionLogs().map(async (file) => {
          const summary = summarizeVoiceSession(parseVoiceLog(await file.text()));
          return summary === null ? [] : [{ name: file.name, summary }];
        }),
      )
        .then((items) => {
          if (!cancelled) setSessions(items.flat());
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  const contentStyle = useListInsets();

  return (
    <LegendList
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={contentStyle}
      data={sessions ?? []}
      estimatedItemSize={72}
      keyExtractor={(session) => session.name}
      ListEmptyComponent={sessions === null ? null : <Empty text="No voice sessions yet." />}
      ListFooterComponent={
        <Text className="px-2 pt-3 text-sm text-foreground-muted">
          The last 20 voice sessions are kept on this phone.
        </Text>
      }
      renderItem={({ item, index }) => (
        <View
          className={cn(
            "overflow-hidden bg-grouped-card",
            index === 0 && "rounded-t-[24px]",
            index === (sessions?.length ?? 0) - 1 && "rounded-b-[24px]",
          )}
        >
          <ListRow
            label={item.summary.preview ?? "Nothing said"}
            description={`${when(item.summary.startedAt)} · ${sessionDetail(item.summary)}`}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsVoiceSession", params: { name: item.name } },
              })
            }
          />
        </View>
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}

/** A tool call, folded to its name until tapped. */
function ToolEntry(props: { readonly entry: Extract<VoiceTimelineEntry, { kind: "tool" }> }) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const status = entry.result === null ? "no result" : entry.failed ? "failed" : `${entry.ms} ms`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((value) => !value)}
      className="gap-2 rounded-[16px] border-continuous bg-subtle px-3 py-2 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
        <Text className="flex-1 font-mono text-sm text-foreground" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text
          className={cn(
            "text-xs",
            entry.failed ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {status}
        </Text>
      </View>
      {open ? (
        <View className="gap-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {entry.args}
          </Text>
          {entry.result !== null ? (
            <Text
              selectable
              className={cn(
                "font-mono text-xs",
                entry.failed ? "text-danger-foreground" : "text-foreground",
              )}
            >
              {entry.result}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function TimelineEntry(props: { readonly entry: VoiceTimelineEntry }) {
  const { entry } = props;
  switch (entry.kind) {
    case "user":
    case "agent":
      return (
        <View className={cn("gap-0.5", entry.kind === "user" ? "items-end pl-10" : "pr-10")}>
          <Text className="text-xs text-foreground-muted">
            {entry.kind === "user" ? "You" : "Agent"} · {clock(entry.at)}
          </Text>
          <View
            className={cn(
              "rounded-[18px] border-continuous px-3 py-2",
              entry.kind === "user" ? "bg-primary/15" : "bg-grouped-card",
            )}
          >
            <Text selectable className="text-base text-foreground">
              {entry.text.trim()}
            </Text>
          </View>
        </View>
      );
    case "dictation":
      return (
        <Card>
          <Text className="text-sm text-foreground-muted">
            Dictation {entry.id} · {clock(entry.at)} · {minutes(entry.seconds)}
          </Text>
          <Text selectable className="text-base leading-normal text-foreground">
            {entry.text}
          </Text>
          <CopyButton text={entry.text} />
        </Card>
      );
    case "feedback":
      return (
        <Card>
          <Text className="text-sm text-foreground-muted">
            Feedback {entry.id} · {clock(entry.at)}
          </Text>
          <Text selectable className="text-base text-foreground">
            {entry.text}
          </Text>
        </Card>
      );
    case "tool":
      return <ToolEntry entry={entry} />;
    case "update":
      return (
        <Text selectable className="px-2 text-sm text-foreground-muted">
          App update · {entry.text}
        </Text>
      );
    case "note":
      return (
        <Text
          className={cn(
            "px-2 text-center text-xs",
            entry.error ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {clock(entry.at)} · {entry.text}
        </Text>
      );
  }
}

const transcriptText = (entries: ReadonlyArray<VoiceTimelineEntry>) =>
  entries
    .flatMap((entry) => {
      switch (entry.kind) {
        case "user":
          return [`You: ${entry.text.trim()}`];
        case "agent":
          return [`Agent: ${entry.text.trim()}`];
        case "dictation":
          return [`Dictation ${entry.id}:\n${entry.text}`];
        default:
          return [];
      }
    })
    .join("\n\n");

/** One session as it happened: what was said and dictated, the tool calls, and the connection. */
export function SettingsVoiceSessionRouteScreen({
  route,
}: StaticScreenProps<{ readonly name: string }>) {
  const { name } = route.params;
  const [entries, setEntries] = useState<ReadonlyArray<VoiceTimelineEntry> | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void readVoiceSessionLog(name).then((text) => {
      if (text === null) setMissing(true);
      else setEntries(voiceTimeline(parseVoiceLog(text)));
    });
  }, [name]);
  const contentStyle = useListInsets();

  const share = () => {
    const file = voiceSessionLogs().find((log) => log.name === name);
    if (file === undefined) return;
    void shareAsync(file.uri, { mimeType: "application/json", UTI: "public.plain-text" }).catch(
      (error: unknown) =>
        Alert.alert(
          "Could not share the log",
          error instanceof Error ? error.message : "Sharing failed.",
        ),
    );
  };

  if (missing) {
    return (
      <View className="flex-1 bg-sheet">
        <Empty text="This session's log is no longer kept." />
      </View>
    );
  }
  return (
    <LegendList
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={contentStyle}
      data={entries ?? []}
      estimatedItemSize={64}
      keyExtractor={(entry, index) => `${index}-${entry.at}`}
      ListHeaderComponent={
        entries === null ? null : (
          <View className="flex-row gap-2 pb-3">
            <CopyButton text={transcriptText(entries)} label="Copy conversation" />
            <Pressable
              accessibilityRole="button"
              className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-60"
              onPress={share}
            >
              <SymbolView
                name="square.and.arrow.up"
                size={14}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-sm text-foreground">Share log</Text>
            </Pressable>
          </View>
        )
      }
      renderItem={({ item }) => (
        <View className="pb-3">
          <TimelineEntry entry={item} />
        </View>
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}
