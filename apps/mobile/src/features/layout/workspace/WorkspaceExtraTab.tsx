import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { DriveScreen } from "../../voice-agent/DriveScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "drive" ? <DriveScreen /> : <UsageRouteScreen workspace />}
    </>
  );
}
