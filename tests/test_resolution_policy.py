from __future__ import annotations

import os
import unittest

from tests.protocol_model import ProviderLocation, ResolutionFailure, resolve_provider


class ProviderResolutionTests(unittest.TestCase):
    def test_project_config_cannot_enable_provider(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "project",
                [global_provider()],
            )

    def test_workspace_config_cannot_enable_provider(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "workspace",
                [global_provider()],
            )

    def test_user_config_can_resolve_global_provider_name(self) -> None:
        resolved = resolve_provider("npm-credential-provider-gitlab", "user", [global_provider()])

        self.assertEqual(resolved.kind, "global-bin")

    def test_global_config_can_resolve_builtin_provider_name(self) -> None:
        resolved = resolve_provider(
            "npm-credential-provider-npm",
            "global",
            [
                ProviderLocation(
                    "npm-credential-provider-npm",
                    "builtin",
                    "/npm/internal/provider",
                )
            ],
        )

        self.assertEqual(resolved.kind, "builtin")

    def test_absolute_path_can_be_resolved_from_user_config(self) -> None:
        absolute_path = os.path.abspath("trusted-bin/npm-credential-provider-gitlab")
        resolved = resolve_provider(
            absolute_path,
            "user",
            [
                ProviderLocation(
                    "npm-credential-provider-gitlab",
                    "absolute",
                    absolute_path,
                )
            ],
        )

        self.assertEqual(resolved.path, absolute_path)

    def test_project_node_modules_cannot_shadow_global_provider(self) -> None:
        resolved = resolve_provider(
            "npm-credential-provider-gitlab",
            "user",
            [
                ProviderLocation(
                    "npm-credential-provider-gitlab",
                    "project-node_modules",
                    "./node_modules/.bin/npm-credential-provider-gitlab",
                ),
                global_provider(),
            ],
        )

        self.assertEqual(resolved.kind, "global-bin")

    def test_current_directory_provider_is_ignored(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "user",
                [
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "cwd",
                        "./npm-credential-provider-gitlab",
                    )
                ],
            )

    def test_path_like_location_is_ignored(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "user",
                [
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "path",
                        "/tmp/npm-credential-provider-gitlab",
                    )
                ],
            )

    def test_ambiguous_trusted_provider_fails_closed(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "user",
                [
                    global_provider(),
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "enterprise",
                        "/opt/company/bin/npm-credential-provider-gitlab",
                    ),
                ],
            )

    def test_missing_provider_fails_closed(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider("npm-credential-provider-gitlab", "user", [])


def global_provider() -> ProviderLocation:
    return ProviderLocation(
        "npm-credential-provider-gitlab",
        "global-bin",
        "/usr/local/bin/npm-credential-provider-gitlab",
    )


if __name__ == "__main__":
    unittest.main()
