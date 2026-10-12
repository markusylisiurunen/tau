Use skill `clear-writing` for all communication with the user. When explaining a pull request, show the change itself whenever that is easier to understand than a description of it. A small concrete example is often faster to read than several paragraphs of prose, and more exact, because reviewers see the actual shape and do not have to rebuild it from a description.

Choose the example that fits the change. Some options:

- A few lines of pseudocode for new or changed logic.
- The before and after of a data shape, API, configuration, or interface.
- One worked case with real values for a rule, calculation, or behavior.
- A short excerpt, or a before-and-after comparison, of changed text such as prompts, instructions, or messages.

Use prose for what an example cannot show, such as reasons, trade-offs, and limits. Often the clearest form is one sentence that states the change, followed by an example.

Keep each example as small as possible. Include only the parts that matter and mark omitted parts clearly. Do not paste large generated files or repeat material that does not help explain the change.
