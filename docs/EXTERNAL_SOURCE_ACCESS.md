# External media source owners

The external-media mount is not a shared library for every administrator.
A SuperAdmin can assign a source subfolder to an active account in the external
folder picker's **External source owners** section. Choose a real folder, choose
an account, then explicitly assign it. Assigning the same folder to another
account transfers future source access. Revoking a grant does not delete files
or photos already published in galleries.

Scoped accounts browse and import only their assigned sources and their
subfolders, into galleries they own. Gallery-wide view/manage permissions do not
grant external-source access or cross-owner import authority. The global mount,
unassigned sources and ownerless sources remain SuperAdmin-only. Source grants
must not overlap; assign disjoint roots instead of giving different accounts a
parent and its child. Symlink aliases cannot be assigned as source roots.

Existing source paths are not automatically converted into grants during an
upgrade. A SuperAdmin must review and assign them explicitly. Existing published
gallery originals remain reachable without being moved or rebased.

Automatic imports run with the current gallery owner's live source and upload
permissions. After an upgrade, ownerless watched galleries need an explicit
owner; scoped owners need a source grant. Revoked/deactivated owners or source
access stop later imports. A SuperAdmin's manual cross-owner import does not
give its destination owner unrestricted access to the mount.

The authenticated API exposes `GET /api/admin/external-media/sources`.
SuperAdmins can assign/transfer with
`PUT /api/admin/external-media/sources` and JSON
`{ "path": "studio/alice", "owner_id": 42 }`, or revoke a grant with
`DELETE /api/admin/external-media/sources/:sourceId`. No operation deletes the
underlying source folder. Review source assignments when restoring a backup
onto an instance with a different external mount.
