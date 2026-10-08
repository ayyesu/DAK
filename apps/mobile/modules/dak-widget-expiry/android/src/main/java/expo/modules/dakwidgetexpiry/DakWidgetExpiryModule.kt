package expo.modules.dakwidgetexpiry

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DakWidgetExpiryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DakWidgetExpiry")
    Function("schedule") { name: String, deadlines: List<Double> ->
      val context = appContext.reactContext ?: return@Function
      WidgetExpiryReceiver.schedule(context, name, deadlines.map { it.toLong() }.toLongArray())
    }
  }
}
