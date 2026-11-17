# Working on Turnkey

Work in this repository for the reusable viewer, build and project-loading code, public geometry and furniture helpers, generic validation, and project-format starters. See the [developer workflow](README.md).

- Treat the project passed to the CLI as the only source of its room names, level geometry, placement, accepted options, branding, deployment hosts, and private evidence. Keep sample data synthetic.
- Preserve the room, level, and asset builder interfaces. Additions should work with existing projects which omit optional fields. Use public imports for helpers used by project code. Keep project hooks optional and specify their fallback.
- Check a change against an independent fixture with its own room and level IDs. The package must be testable and buildable with no particular customer's project on disk. For UI work, also review the relevant behavior in a local preview.
- Ship reusable changes in a versioned package. Check the packed file list for application code and templates before release, and test installation from that archive. A project upgrade pins one release and its lockfile. Changes to a particular project or deployment belong in that project repository.
