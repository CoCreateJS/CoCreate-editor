import { detailsToSource, planDetailsEdit } from "./lengthEditorDetails.js";
import { bindEditorDetails } from "./createEditorDetails.js";
import { renderEditor } from "./renderEditor.js";

function normalizeUpdate(update) {
    if (!update || typeof update !== "object")
        throw new TypeError("An editor text update object is required.");
    const { start, value } = update;
    const end = Number.isInteger(update.end)
        ? update.end
        : Number.isInteger(update.length)
            ? start + update.length
            : NaN;
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof value !== "string")
        throw new TypeError("Update must include integer start, end or length, and string value.");
    return { start, end, value };
}

/**
 * Plan and apply one CRDT-shaped source edit to a length-only details array.
 * The plan is fully built before the original array is reorganized. Once the
 * detail state is committed, the internal renderer applies those lists to the
 * referenced live nodes.
 */
export function updateEditorDetails(details, update) {
    if (!Array.isArray(details))
        throw new TypeError("Editor details must be an array.");

    const { start, end, value } = normalizeUpdate(update);
    const previousSource = detailsToSource(details);
    const plan = planDetailsEdit(details, start, end, value);

    // CRDT events commonly include the resulting full string. Check it before
    // mutating the stored array so a stale or mismatched event cannot corrupt it.
    const expectedSource = update.string;
    const nextSource = previousSource.slice(0, start) + value + previousSource.slice(end);
    if (typeof expectedSource === "string" && expectedSource !== nextSource)
        throw new RangeError("CRDT update does not match the supplied editor details.");

    for (const { detail, value } of plan.edited) {
        detail.value = value;
        detail.length = detail.value.length;
    }
    details.length = 0;
    for (const detail of plan.nextDetails) details.push(detail);
    for (const detail of plan.added) bindEditorDetails(detail, details);
    const editor = details[0]?.editor || plan.removed[0]?.detail.editor || plan.added[0]?.editor;
    renderEditor(editor, { ...plan, editorDetails: details });

    return {
        ...plan,
        editorDetails: details,
        previousSource,
        source: nextSource
    };
}

export default updateEditorDetails;
