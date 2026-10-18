"""Schemathesis hooks for the KajianQ API fuzz run.

The `/v1/chat` contract refuses a `message` the store cannot hold — U+0000 or an
unpaired surrogate — with `400 invalid_request`, and the emitted schema states
that rule as a `pattern`. The validator Schemathesis canonicalizes with cannot
compile a pattern that names UTF-16 surrogates, so it drops the pattern and the
generator produces bodies the route must refuse.

This hook reads that same published `pattern` from the served schema and accepts
a positive case's 400 exactly when the generated `message` does not match it. A
400 on any storable message is still a failure, and so is every other check.
"""

import re

from schemathesis import hook
from schemathesis.openapi.checks import RejectedPositiveData

CHAT_MESSAGE = ("POST", "/v1/chat")


def _published_message_pattern(schema):
    """The `pattern` the served document publishes for the chat message, compiled.

    `None` when the document carries no pattern (nothing documents the rule, so
    no rejection is accepted) or Python cannot compile it (the run then fails
    loudly rather than accepting a rejection it cannot justify).
    """
    try:
        message = schema.raw_schema["paths"]["/v1/chat"]["post"]["requestBody"]["content"][
            "application/json"
        ]["schema"]["properties"]["message"]
    except (KeyError, AttributeError, TypeError):
        return None
    pattern = message.get("pattern") if isinstance(message, dict) else None
    if not isinstance(pattern, str):
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


@hook("filter_failure")
def accept_documented_unstorable_message_rejection(context, failure, case, response):
    """Drop the positive-data failure only for the contract's own unstorable-message 400."""
    if not isinstance(failure, RejectedPositiveData):
        return True
    if response.status_code != 400:
        return True
    if (str(case.method).upper(), case.path) != CHAT_MESSAGE:
        return True
    body = case.body
    if not isinstance(body, dict):
        return True
    message = body.get("message")
    if not isinstance(message, str):
        return True
    pattern = _published_message_pattern(case.operation.schema)
    if pattern is None:
        return True
    # `search` mirrors the schema's `pattern` semantics (JSON Schema does not
    # anchor it); the published pattern anchors itself with `^` and `$`.
    return pattern.search(message) is not None
