# Graph reference

## Tools (15)

`index_repository`, `index_status`, `list_projects`, `delete_project`,
`search_graph`, `search_code`, `trace_path`, `detect_changes`,
`query_graph`, `get_graph_schema`, `get_code_snippet`, `get_architecture`,
`check_index_coverage`, `manage_adr`, `ingest_traces`

## Edge types

CALLS, HTTP_CALLS, ASYNC_CALLS, DATA_FLOWS, IMPORTS, DEFINES, DEFINES_METHOD,
HANDLES, IMPLEMENTS, OVERRIDE, USAGE, CALL_REFERENCE, CONFIGURES,
FILE_CHANGES_WITH, SIMILAR_TO, SEMANTICALLY_RELATED, CONTAINS_FILE,
CONTAINS_FOLDER, CONTAINS_PACKAGE

## Cypher examples (query_graph)

```cypher
MATCH (a)-[r:HTTP_CALLS]->(b) RETURN a.name, b.name, r.url_path, r.confidence LIMIT 20
MATCH (f:Function) WHERE f.name =~ '.*Handler.*' RETURN f.name, f.file_path
MATCH (a)-[r:CALLS]->(b) WHERE a.name = 'main' RETURN b.name
```

## Gotchas

1. `search_graph(relationship="HTTP_CALLS")` filters nodes by degree. For actual
   edges, use `query_graph` with Cypher.
2. `query_graph` has a 100k row ceiling. Add a Cypher `LIMIT` to a broad query,
   or use `search_graph` pagination.
3. `trace_path` needs exact names. Run `search_graph(name_pattern=...)` first.
4. `direction="outbound"` misses cross-service callers. Use `direction="both"`
   when the boundary is unknown.
5. `search_graph` returns 50 results per page. Check `has_more` and use `offset`.
