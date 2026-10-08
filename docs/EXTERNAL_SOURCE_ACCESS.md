# External media source owners

The external-media mount is not a shared library for every administrator.
A SuperAdmin can assign a source subfolder to an active account in the external
folder picker's **External source owners** section. Choose a real folder, choose
an account, then explicitly assign it. Assigning the same folder to another
account transfers future source access. Revoking a grant does not delete files
or photos already published in galleries.

Grants gate browsing and new bindings. A scoped account browses only its
assigned sources and their subfolders, and can point a gallery at a folder only
inside them. Gallery-wide view/manage permissions do not grant external-source
access. The global mount and unassigned folders remain SuperAdmin-only for
browsing and for new bindings. Source grants must not overlap; assign disjoint
roots instead of giving different accounts a parent and its child. Symlink
aliases cannot be assigned as source roots.

The folder a gallery already points at keeps working for that gallery without a
grant: whoever may manage the gallery (its creator, a role holding `events.manage_all`, an account assigned to
the gallery, or anyone for an ownerless gallery) can rescan and import from it,
and its folder watcher keeps running. That covers every gallery bound before an
upgrade, so existing source paths are not converted into grants and need none.
It also means revoking or transferring a grant stops browsing and new bindings,
not the galleries already bound to the folder; switch such a gallery to managed
uploads, or point it elsewhere, to detach it. Saving a gallery without changing
its folder asks for no source access. Paths saved by earlier releases with a
leading slash or a colon in a folder name are still read; new input accepts
neither.

Automatic imports run on behalf of the gallery's creator, who must be an active
account holding `photos.upload`; an ownerless gallery's watcher follows its
stored folder. When a watcher is refused, the server log carries one warning
per gallery with the gallery, the folder and the reason. Published originals
are read from wherever their stored path leads inside the mount, including
through a directory link that stays inside it; a link leaving the mount is
refused.

The authenticated API exposes `GET /api/admin/external-media/sources`.
SuperAdmins can assign/transfer with
`PUT /api/admin/external-media/sources` and JSON
`{ "path": "studio/alice", "owner_id": 42 }`, or revoke a grant with
`DELETE /api/admin/external-media/sources/:sourceId`. No operation deletes the
underlying source folder. Review source assignments when restoring a backup
onto an instance with a different external mount.
