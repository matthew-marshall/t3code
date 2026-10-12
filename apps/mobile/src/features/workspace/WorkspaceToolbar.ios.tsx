import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import type { SearchBarCommands } from "react-native-screens";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useVoiceAgentToggle } from "../voice-agent/useVoiceAgentToggle";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** Root actions stay in the header; UIKit owns the bottom compose button. */
export function WorkspaceToolbar(props: {
  readonly onNewTask: () => void;
  readonly sidebar?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const metrics = useNativeLayoutMetrics();
  const nativeToolbarCompose =
    Platform.OS === "ios" && (Platform.isPad || (metrics?.verticalBarEdge ?? "none") !== "none");
  const { isTabActive } = workspace;
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const { panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const voiceAgent = useVoiceAgentToggle();
  const searchRef = useRef<SearchBarCommands>(null);
  const tab = workspace.state.tabs[workspace.state.selectedTab];
  const selectedTab = workspace.state.selectedTab;
  const searchable = selectedTab !== "drive";
  const focusSearch = useCallback(() => {
    if (!searchable || !workspace.isTabActive(selectedTab)) return false;
    workspace.dispatch({
      type: "scroll",
      tab: selectedTab,
      offset: workspace.getScrollOffset(selectedTab),
    });
    workspace.dispatch({ type: "search", tab: selectedTab });
    if (props.sidebar && !panes.primarySidebarVisible) togglePrimarySidebar();
    searchRef.current?.focus();
    return true;
  }, [
    searchable,
    workspace,
    selectedTab,
    props.sidebar,
    panes.primarySidebarVisible,
    togglePrimarySidebar,
  ]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const restoreSearch = useCallback(() => {
    if (isTabActive(selectedTab) && tab.searchMode !== "resting")
      searchRef.current?.setText(tab.query);
  }, [isTabActive, selectedTab, tab.searchMode, tab.query]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreSearch);
      return () => cancelAnimationFrame(frame);
    }, [restoreSearch]),
  );
  useEffect(() => {
    if (!tabActive) return;
    const frame = requestAnimationFrame(restoreSearch);
    return () => cancelAnimationFrame(frame);
  }, [restoreSearch, tabActive]);
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[selectedTab, tab.searchMode]}
        options={{
          headerSearchBarOptions:
            tab.searchMode !== "resting"
              ? {
                  ref: searchRef,
                  autoFocus: tab.searchMode === "active",
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked",
                  allowToolbarIntegration: false,
                  placeholder:
                    selectedTab === "pullRequests" ? "Search pull requests" : "Search threads",
                  cancelButtonText: "✕",
                  onFocus: () => workspace.dispatch({ type: "search", tab: selectedTab }),
                  onBlur: () => workspace.dispatch({ type: "expand", tab: selectedTab }),
                  onSearchButtonPress: () => searchRef.current?.blur(),
                  onChangeText: ({ nativeEvent }) =>
                    workspace.dispatch({
                      type: "query",
                      query: nativeEvent.text,
                      tab: selectedTab,
                    }),
                  onCancelButtonPress: () => {
                    workspace.recordScrollOffset(selectedTab, tab.searchEntryOffset);
                    workspace.dispatch({ type: "cancel", tab: selectedTab });
                  },
                }
              : undefined,
        }}
      />
      {/* UIKit lays trailing items out from the edge inward. */}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Settings"
          icon="gearshape"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
        />
        {searchable ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel={
              selectedTab === "pullRequests" ? "Search pull requests" : "Search threads"
            }
            icon="magnifyingglass"
            onPress={focusSearch}
          />
        ) : null}
        {voiceAgent.visible ? (
          <NativeHeaderToolbar.Button
            identifier="workspace-voice-agent"
            // Its own glass pill rather than a slot in the search/settings group: taps near the
            // group's edge animated the group without reaching this button.
            separateBackground
            accessibilityLabel={voiceAgent.active ? "End voice" : "Talk to T3 Code"}
            icon={voiceAgent.active ? "waveform.circle.fill" : "waveform"}
            onPress={voiceAgent.toggle}
          />
        ) : null}
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="bottom">
        {nativeToolbarCompose ? <NativeHeaderToolbar.Spacer flexible /> : null}
        {nativeToolbarCompose ? (
          <NativeHeaderToolbar.Button
            identifier="workspace-compose"
            accessibilityLabel="New chat"
            icon="square.and.pencil"
            onPress={props.onNewTask}
            separateBackground
          />
        ) : null}
      </NativeHeaderToolbar>
    </>
  );
}
