# Reads git pre-push ref tuples ("<local_ref> <local_oid> <remote_ref> <remote_oid>") on stdin.
# Echoes exactly: "<touches_main(0|1)> <main_local_oid> <main_remote_oid>"
# (OIDs empty when refs/heads/main is not among the pushed refs). EXACT match on the
# remote_ref field (refs/heads/main only - NOT refs/heads/main-foo).
parse_pushed_main_ref() {
  touches_main=0
  main_local_oid=""
  main_remote_oid=""

  while IFS=' ' read -r l_ref l_oid r_ref r_oid; do
    if [ "$r_ref" = "refs/heads/main" ]; then
      touches_main=1
      main_local_oid="$l_oid"
      main_remote_oid="$r_oid"
    fi
  done

  printf '%s %s %s\n' "$touches_main" "$main_local_oid" "$main_remote_oid"
}
