"""Skips for a missing tool that CI turns into failures.

A test that needs node, cargo or jsonschema is skipped where the tool is
missing, which is right on a machine that has not got it and wrong on the CI
runner, where a skip is a check that quietly did not run. With
`REQUIRE_TOOLS=1` in the environment (the workflows set it) a missing tool is a
failure instead.
"""

from __future__ import annotations

import os
import unittest
from collections.abc import Callable
from typing import Any


def required() -> bool:
    return os.environ.get("REQUIRE_TOOLS") == "1"


def skip_or_fail(test: unittest.TestCase, reason: str) -> None:
    """For a skip decided while a test runs."""
    if required():
        test.fail(f"{reason} (REQUIRE_TOOLS=1 makes that a failure)")
    test.skipTest(reason)


def needs(available: bool, reason: str) -> Callable[[Any], Any]:
    """A decorator for a test or a test class: a no-op where the tool is
    there, a skip where it is not, a failure where it is not and is required."""

    def decorate(target: Any) -> Any:
        if available:
            return target
        if not required():
            return unittest.skip(reason)(target)
        message = f"{reason} (REQUIRE_TOOLS=1 makes that a failure)"
        if isinstance(target, type):

            def set_up_class(cls: type) -> None:
                raise AssertionError(message)

            target.setUpClass = classmethod(set_up_class)
            return target

        def fail(*args: Any, **kwargs: Any) -> None:
            raise AssertionError(message)

        fail.__name__ = getattr(target, "__name__", "fail")
        return fail

    return decorate
