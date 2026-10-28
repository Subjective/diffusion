"""Local engine that turns a GitHub PR into a guided, linked review walkthrough."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("diffusion-review")
except PackageNotFoundError:  # running from a source tree that isn't installed
    __version__ = "0.0.0"
