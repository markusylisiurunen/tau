# Go patterns

Load this reference when the deslop target contains Go.

## Make absence meaningful

Use pointers, `nil`, and optional wrapper types only when absence is a real domain state. A pointer used merely to avoid updating constructors or call sites weakens the contract and spreads nil handling through otherwise straightforward code.

When every caller supplies a value, use the value directly. When empty and absent differ, make that distinction explicit and document it at the owning boundary.

```go
// slop: every caller passes Jobs and nil becomes an empty slice
type Batch struct {
	Jobs *[]Job
}

// tighter: an empty batch is represented by an empty slice
type Batch struct {
	Jobs []Job
}
```

## Trust constructed internal values

Validate and normalize external input at the handler, decoder, or constructor that owns the boundary. Internal functions should receive values that already satisfy their invariants.

Repeated nil checks, zero-value fallbacks, trimming, length checks, and shape validation deep in a call path usually mean the boundary is weak or ownership is unclear. Move the rule to the boundary and remove downstream duplicates.

```go
// slop: every layer repeats normalization
func saveUser(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("name is required")
	}
	return store.Save(name)
}

// tighter: the boundary produces a valid domain value
name, err := ParseUserName(request.Name)
if err != nil {
	return err
}
return saveUser(name)
```

## Do not hide errors with zero values

Do not swallow an error and continue with `nil`, an empty slice, an empty string, or a zero-valued struct unless that fallback is the documented contract. Return the error with useful context or handle the specific failure at the layer that owns recovery.

Remove logging-and-continuing when the caller needs to know the operation failed. Avoid returning both a misleading usable value and a non-nil error.

```go
// slop
func loadConfig(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("could not load config: %v", err)
		return []byte{}, nil
	}
	return data, nil
}

// tighter
func loadConfig(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	return data, nil
}
```

## Keep cleanup ownership obvious

Place `defer` only after successful resource acquisition and in the function that owns the resource lifetime. Check the acquisition error before scheduling cleanup.

```go
// slop
file, err := os.Open(path)
defer file.Close()
if err != nil {
	return err
}

// tighter
file, err := os.Open(path)
if err != nil {
	return err
}
defer file.Close()
```

Watch for cleanup acting on the wrong path, handle, transaction, or temporary resource after state has moved or ownership has transferred. A deferred closure should capture the exact resource it owns, not mutable state that may later point elsewhere.

Do not use `defer` when the surrounding loop or long-lived function would retain resources beyond their intended lifetime. Introduce a smaller owning function when that makes cleanup timing explicit.

## Remove vestigial struct state

Delete struct fields and parameters that are always their zero value, always `nil`, or written but never read. Remove associated constructor arguments, serialization tags, branches, and tests in the same change.

Do not preserve a field merely because the zero value makes it cheap. Dead state still expands the contract and invites future ambiguity.

```go
// slop: LegacyID is never assigned or read
type User struct {
	ID       string
	LegacyID string
}

// tighter
type User struct {
	ID string
}
```

## Keep representations canonical

Watch for parallel structs representing the same concept across domain, storage, transport, and presentation layers. Share one owned type when the contracts are truly identical. When boundaries need different structs, use an explicit conversion function and keep field meaning and optionality aligned.

Do not accept multiple JSON or storage shapes indefinitely without a compatibility requirement. Decode the canonical form, reject unexpected alternatives, and migrate or reset obsolete data when project context permits.

## Keep interfaces earned

An interface should express a real boundary, support multiple meaningful implementations, or isolate a dependency that callers should not own. Remove one-implementation interfaces and pass-through adapters that add no policy or invariant.

Prefer accepting the smallest interface needed at the consumer, but do not create an interface solely to mock a trivial function in a low-value test.

```go
// slop: one implementation and no boundary policy
type UserLoader interface {
	Load(string) (User, error)
}

type userLoader struct {
	store *Store
}

func (l *userLoader) Load(id string) (User, error) {
	return l.store.LoadUser(id)
}

// tighter
user, err := store.LoadUser(id)
```

## Keep helpers substantial

Inline helpers with one trivial caller when the name and indirection obscure more than the body explains. Keep a helper when it centralizes an invariant, owns resource or error handling, or makes several callers consistent.

Avoid generic utility packages that collect unrelated one-line helpers. Put behavior with the package that owns the concept.

## Test behavior, not syntax

Keep tests for lifecycle, concurrency, persistence, parsing, security boundaries, and error behavior that is easy to regress. Remove tests that only assert a literal return, zero-value initialization, direct field assignment, or a wrapper forwarding its arguments.

Heavy mocking and large fake interfaces often indicate the production boundary is too broad. Tighten the design before adding more test machinery.
