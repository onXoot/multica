"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@multica/core/auth";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { paths, resolvePostAuthDestination } from "@multica/core/paths";
import { api } from "@multica/core/api";
import type { User } from "@multica/core/types";
import { createLogger } from "@multica/core/logger";
import { validateCliCallback, redirectToCliCallback } from "@multica/views/auth";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@multica/ui/components/ui/card";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";
import { Loader2 } from "lucide-react";
import { callbackErrorFrom, type CallbackError } from "./callback-error";

const authLogger = createLogger("auth.callback");

type HandoffPlatform = "desktop" | "mobile";

function CallbackContent() {
  const { t } = useT("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const loginWithOIDC = useAuthStore((s) => s.loginWithOIDC);
  const [error, setError] = useState<CallbackError | null>(null);
  const [handoff, setHandoff] = useState<{
    token: string;
    platform: HandoffPlatform;
  } | null>(null);

  useEffect(() => {
    const errorParam = searchParams.get("error");
    if (errorParam) {
      authLogger.warn("OAuth provider returned an error parameter", errorParam);
      setError(
        errorParam === "access_denied"
          ? { kind: "access_denied" }
          : { kind: "login_failed" },
      );
      return;
    }

    const code = searchParams.get("code");
    if (!code) {
      setError({ kind: "missing_code" });
      return;
    }

    const state = searchParams.get("state") || "";
    const redirectUri = `${window.location.origin}/login/callback`;

    const parseAppState = (appState: string) => {
      const stateParts = appState.split(",");
      const nextPart = stateParts.find((part) => part.startsWith("next:"));
      const cliCallbackPart = stateParts.find((part) =>
        part.startsWith("cli_callback:"),
      );
      const cliStatePart = stateParts.find((part) =>
        part.startsWith("cli_state:"),
      );
      // `next` is encodeURIComponent'd by the login page (same as the cli_*
      // parts) so a comma in the URL survives the comma-joined app_state.
      // Guard the decode independently: a malformed `next` must not void the
      // CLI redirect, and vice versa.
      let nextRaw: string | null = null;
      try {
        nextRaw = nextPart ? decodeURIComponent(nextPart.slice(5)) : null;
      } catch {
        nextRaw = null;
      }
      let cliCallbackRaw: string | null = null;
      let cliState = "";
      try {
        cliCallbackRaw = cliCallbackPart
          ? decodeURIComponent(cliCallbackPart.slice("cli_callback:".length))
          : null;
        cliState = cliStatePart
          ? decodeURIComponent(cliStatePart.slice("cli_state:".length))
          : "";
      } catch {
        cliCallbackRaw = null;
      }
      const handoffPlatform: HandoffPlatform | null = stateParts.includes(
        "platform:mobile",
      )
        ? "mobile"
        : stateParts.includes("platform:desktop")
          ? "desktop"
          : null;
      return {
        handoffPlatform,
        nextUrl: sanitizeNextUrl(nextRaw),
        cliCallback:
          cliCallbackRaw && validateCliCallback(cliCallbackRaw)
            ? cliCallbackRaw
            : null,
        cliState,
      };
    };

    const completeWebLogin = async (loggedInUser: User, nextUrl: string | null) => {
      const wsList = await api.listWorkspaces();
      qc.setQueryData(workspaceKeys.list(), wsList);
      const onboarded = loggedInUser.onboarded_at != null;

      if (nextUrl) {
        router.push(nextUrl);
        return;
      }

      if (!onboarded) {
        try {
          const invites = await api.listMyInvitations();
          if (invites.length > 0) {
            qc.setQueryData(workspaceKeys.myInvitations(), invites);
            router.push(paths.invitations());
            return;
          }
        } catch {
          // A failed invitation lookup must not trap the user on the callback page.
        }
      }

      router.push(resolvePostAuthDestination(wsList, onboarded));
    };

    if (state.startsWith("oidc.")) {
      loginWithOIDC(code, state)
        .then(({ user, token, appState }) => {
          const destination = parseAppState(appState);
          if (destination.cliCallback) {
            redirectToCliCallback(
              destination.cliCallback,
              token,
              destination.cliState,
            );
            return;
          }
          if (destination.handoffPlatform) {
            setHandoff({
              token,
              platform: destination.handoffPlatform,
            });
            window.location.href = `multica://auth/callback?token=${encodeURIComponent(token)}`;
            return;
          }
          return completeWebLogin(user, destination.nextUrl);
        })
        .catch((err) => {
          authLogger.error("OIDC callback failed", err);
          setError(callbackErrorFrom(err));
        });
      return;
    }

    const destination = parseAppState(state);
    const handoffPlatform = destination.handoffPlatform;

    if (destination.cliCallback) {
      // CLI login flow: exchange the Google code for a JWT, then redirect the
      // token back to the CLI's local HTTP listener (e.g. WSL2 host).
      api
        .googleLogin(code, redirectUri)
        .then(({ token }) => {
          redirectToCliCallback(
            destination.cliCallback!,
            token,
            destination.cliState,
          );
        })
        .catch((err) => {
          authLogger.error("CLI Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else if (handoffPlatform) {
      // Native app flow: exchange code for token, then redirect via deep link.
      api
        .googleLogin(code, redirectUri)
        .then(({ token }) => {
          setHandoff({ token, platform: handoffPlatform });
          window.location.href = `multica://auth/callback?token=${encodeURIComponent(token)}`;
        })
        .catch((err) => {
          authLogger.error("Native app Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else {
      // Normal web flow
      loginWithGoogle(code, redirectUri)
        .then((loggedInUser) =>
          completeWebLogin(loggedInUser, destination.nextUrl),
        )
        .catch((err) => {
          authLogger.error("Web Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    }
  }, [searchParams, loginWithGoogle, loginWithOIDC, router, qc]);

  const errorDescription = (() => {
    if (!error) return null;
    switch (error.kind) {
      case "raw":
        return error.text;
      case "missing_code":
        return t(($) => $.web.callback.missing_code);
      case "access_denied":
        return t(($) => $.web.callback.access_denied);
      case "login_failed":
        return t(($) => $.web.callback.login_failed);
      case "account_disabled":
        return t(($) => $.web.callback.account_disabled);
      case "signup_prohibited":
        return t(($) => $.web.callback.signup_prohibited);
      case "email_not_allowed":
        return t(($) => $.web.callback.email_not_allowed);
      case "google_account_no_email":
        return t(($) => $.web.callback.google_account_no_email);
      case "oauth_code_invalid":
        return t(($) => $.web.callback.oauth_code_invalid);
    }
  })();

  if (handoff) {
    // Mobile and desktop both land here after the provider round-trip, so the
    // copy follows the platform the deep link is about to open.
    const isMobileHandoff = handoff.platform === "mobile";
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) =>
                isMobileHandoff
                  ? $.web.mobile_handoff.opening_title
                  : $.web.desktop_handoff.opening_title,
              )}
            </CardTitle>
            <CardDescription>
              {t(($) =>
                isMobileHandoff
                  ? $.web.mobile_handoff.opening_description
                  : $.web.desktop_handoff.opening_description,
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = `multica://auth/callback?token=${encodeURIComponent(handoff.token)}`;
              }}
            >
              {t(($) =>
                isMobileHandoff
                  ? $.web.mobile_handoff.open_button
                  : $.web.desktop_handoff.open_button,
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.callback.failed_title)}
            </CardTitle>
            <CardDescription>
              {errorDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <a href={paths.login()} className="text-primary underline-offset-4 hover:underline">
              {t(($) => $.web.callback.back_to_login)}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-display-sm">
            {t(($) => $.web.callback.signing_in)}
          </CardTitle>
          <CardDescription>
            {t(($) => $.web.callback.signing_in_description)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
