import { View } from "react-native";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useVoiceAgentToggle } from "../voice-agent/useVoiceAgentToggle";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

export function WorkspaceSidebarTabs() {
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectWorkspaceTab();
  const driveAvailable = useVoiceAgentToggle().visible;
  return (
    <View className="px-4 pb-3 pt-2">
      <SegmentedControl
        role="tab"
        options={[
          { value: "threads", label: "Threads" },
          { value: "pullRequests", label: "Pull requests" },
          ...(driveAvailable ? [{ value: "drive" as const, label: "Drive" }] : []),
        ]}
        selected={workspace.state.selectedTab}
        onSelect={(tab: WorkspaceTab) => selectTab(tab)}
      />
    </View>
  );
}
