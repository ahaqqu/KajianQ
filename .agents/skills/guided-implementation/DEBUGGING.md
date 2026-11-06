# Debugging a bug

Build the **tight**, **red** loop before you theorise or edit: name one command you have already run — paste the invocation and its output — that drives the bug's code path, asserts the user's exact symptom, and is deterministic and fast. Treat the loop as a product and tighten it: cache the setup, sharpen the assertion to the symptom, pin time, seed RNG, freeze the network; for a flaky bug, raise the reproduction rate until it is debuggable. With no loop built, stop — list what you tried, and ask for the environment or captured artifact that reproduces the bug.
