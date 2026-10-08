#pragma once

#include <react/renderer/components/DakMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/DakMarkdownTextSpec/Props.h>
#include <react/renderer/components/DakMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char DakMarkdownTextRunComponentName[];

using DakMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    DakMarkdownTextRunComponentName,
    DakMarkdownTextRunProps,
    DakMarkdownTextRunEventEmitter,
    DakMarkdownTextRunState>;
}
