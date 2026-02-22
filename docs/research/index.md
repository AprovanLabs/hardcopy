# hardcopy research

```cypher
MATCH (p:Person {name: "John"})-[r:FOLLOWS]->(other)
RETURN other.name AS FollowedPersonName, type(r) AS RelationshipType
LIMIT 10
```

Cypher: Loading views of primitives
PromQL: Loading event streams?

Could we combine these into a single view?


https://www.webmcp-hub.com/

https://openai.com/index/harness-engineering/

https://colliery-io.github.io/graphqlite/latest/
