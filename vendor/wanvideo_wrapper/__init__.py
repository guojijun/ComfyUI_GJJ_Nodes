"""GJJ-vendored WanVideoWrapper runtime subset.

This package intentionally does not import or register upstream nodes at import
time. GJJ node wrappers import only the vendored runtime modules they need.
"""

VENDORED_BY_GJJ = True
