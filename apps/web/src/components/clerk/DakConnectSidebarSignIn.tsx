import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { DAK_CONNECT_ACCOUNT_PAGES } from "./DakConnectAccountPages";
import { useDakConnectAuthPrompt } from "./useDakConnectAuthPrompt";

export function DakConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredDakConnectSidebarSignIn />;
}

export function DakConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredDakConnectSidebarAvatar />;
}

function ConfiguredDakConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {DAK_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredDakConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useDakConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to DAK Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
