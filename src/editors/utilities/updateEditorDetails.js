import { detailsToSource, planDetailsEdit } from "./lengthEditorDetails.js";
import { bindEditor } from "./createEditor.js";
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
export function updateEditorDetails(details, update, { planner = planDetailsEdit, render = renderEditor, editor } = {}) {
    if (!Array.isArray(details))
        throw new TypeError("Editor details must be an array.");

    const { start, end, value } = normalizeUpdate(update);
    const previousSource = detailsToSource(details);

    // CRDT events commonly include the resulting full string. Check it before
    // mutating the stored array so a stale or mismatched event cannot corrupt it.
    const expectedSource = update.string;
    const nextSource = previousSource.slice(0, start) + value + previousSource.slice(end);
    if (typeof expectedSource === "string" && expectedSource !== nextSource)
        throw new RangeError("CRDT update does not match the supplied editor details.");

    const plan = planner(details, start, end, value, { previousSource, source: nextSource });
    return applyEditorDetailsPlan(details, { ...plan, previousSource, source: nextSource }, { render, editor });
}

/** Commit a completed plan, preserving removed references until rendering ends. */
export function applyEditorDetailsPlan(details, plan, { render = renderEditor, editor } = {}) {
    const stale = plan.baseDetails && plan.baseValues
        ? details.length !== plan.baseDetails.length || details.some((detail, index) =>
            detail !== plan.baseDetails[index] || detail.value !== plan.baseValues[index] || detail.length !== detail.value.length)
        : plan.previousSource !== detailsToSource(details) || (plan.baseDetails &&
            (details.length !== plan.baseDetails.length || details.some((detail, index) => detail !== plan.baseDetails[index])));
    if (stale)
        throw new Error("Editor details changed after this edit was staged.");

    for (const { detail, value, changes } of plan.edited) {
        if (changes) Object.assign(detail, changes);
        detail.value = value;
        detail.length = detail.value.length;
    }
    if (details.length !== plan.nextDetails.length || details.some((detail, index) => detail !== plan.nextDetails[index])) {
        details.length = 0;
        for (const detail of plan.nextDetails) details.push(detail);
    }
    for (const detail of plan.added) bindEditor(detail, details);
    editor ||= details[0]?.element || plan.removed[0]?.detail.element || plan.added[0]?.element;
    const rendered = render(editor, { ...plan, editorDetails: details });

    return {
        ...plan,
        editorDetails: details,
        rendered
    };
}

export default updateEditorDetails;
