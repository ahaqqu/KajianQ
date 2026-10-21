"""Schemathesis hooks for the KajianQ API fuzz run.

The chat and feedback contracts refuse a body field the store cannot hold —
U+0000 or an unpaired surrogate — with `400 invalid_request`, and the emitted
schemas state that rule as a `pattern`: the chat `message` and the feedback
`freeText` carry the same storability rule. The validator Schemathesis
canonicalizes with cannot compile a pattern that names UTF-16 surrogates, so it
drops the pattern and the generator produces values the routes must refuse.

This hook reads that same published `pattern` from the served schema and accepts
a positive case's 400 exactly when the generated field does not match it. A 400
on any storable value is still a failure, and so is every other check.
"""

import re

from schemathesis import hook
from schemathesis.openapi.checks import RejectedPositiveData

# The routes whose body carries the storability rule, and the field it guards.
STORABLE_FIELDS = {
    ("POST", "/v1/chat"): "message",
    ("POST", "/v1/feedback"): "freeText",
}


def _published_pattern(schema, path, field):
    """The `pattern` the served document publishes for `field`, compiled.

    `None` when the document carries no pattern (nothing documents the rule, so
    no rejection is accepted) or Python cannot compile it (the run then fails
    loudly rather than accepting a rejection it cannot justify). The feedback
    body is a union of two shapes, so the field is looked up in each arm.
    """
    try:
        body = schema.raw_schema["paths"][path]["post"]["requestBody"]["content"][
            "application/json"
        ]["schema"]
    except (KeyError, AttributeError, TypeError):
        return None
    shapes = body.get("anyOf") if isinstance(body, dict) else None
    candidates = shapes if isinstance(shapes, list) else [body]
    for shape in candidates:
        if not isinstance(shape, dict):
            continue
        candidate = shape.get("properties", {}).get(field)
        pattern = candidate.get("pattern") if isinstance(candidate, dict) else None
        if isinstance(pattern, str):
            try:
                return re.compile(pattern)
            except re.error:
                return None
    return None


@hook("filter_failure")
def accept_documented_unstorable_field_rejection(context, failure, case, response):
    """Drop the positive-data failure only for the contract's own unstorable 400."""
    if not isinstance(failure, RejectedPositiveData):
        return True
    if response.status_code != 400:
        return True
    field = STORABLE_FIELDS.get((str(case.method).upper(), case.path))
    if field is None:
        return True
    body = case.body
    if not isinstance(body, dict):
        return True
    value = body.get(field)
    if not isinstance(value, str):
        return True
    pattern = _published_pattern(case.operation.schema, case.path, field)
    if pattern is None:
        return True
    # `search` mirrors the schema's `pattern` semantics (JSON Schema does not
    # anchor it); the published pattern anchors itself with `^` and `$`.
    return pattern.search(value) is not None
