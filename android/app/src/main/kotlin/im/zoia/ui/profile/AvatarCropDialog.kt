package im.zoia.ui.profile

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ZoomIn
import androidx.compose.material.icons.filled.ZoomOut
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

@Composable
fun AvatarCropDialog(
    bitmap: Bitmap,
    onCancel: () -> Unit,
    onSave: suspend (ByteArray) -> String?
) {
    val scope = rememberCoroutineScope()
    var zoom by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var isSaving by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val density = LocalDensity.current
    val viewportDp = 260.dp
    val viewportPx = with(density) { viewportDp.toPx() }

    val minDim = min(bitmap.width, bitmap.height).toFloat()
    val baseScale = viewportPx / minDim
    val totalScale = baseScale * zoom

    val displayedWidth = bitmap.width * totalScale
    val displayedHeight = bitmap.height * totalScale

    val maxOffsetX = max(0f, (displayedWidth - viewportPx) / 2f)
    val maxOffsetY = max(0f, (displayedHeight - viewportPx) / 2f)

    // Keep offset clamped
    val clampedOffset = Offset(
        x = offset.x.coerceIn(-maxOffsetX, maxOffsetX),
        y = offset.y.coerceIn(-maxOffsetY, maxOffsetY)
    )

    AlertDialog(
        onDismissRequest = { if (!isSaving) onCancel() },
        containerColor = Color(0xFF161920),
        title = {
            Text(
                text = "Recortar Foto de Perfil",
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Arraste e ajuste o zoom para enquadrar seu avatar no círculo.",
                    color = Color(0xFF8E95A5),
                    fontSize = 13.sp
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Cropping Box
                Box(
                    modifier = Modifier
                        .size(viewportDp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color(0xFF0D0F12))
                        .pointerInput(displayedWidth, displayedHeight, zoom) {
                            detectDragGestures { change, dragAmount ->
                                change.consume()
                                offset = Offset(
                                    x = (offset.x + dragAmount.x).coerceIn(-maxOffsetX, maxOffsetX),
                                    y = (offset.y + dragAmount.y).coerceIn(-maxOffsetY, maxOffsetY)
                                )
                            }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    val imageBitmap = remember(bitmap) { bitmap.asImageBitmap() }

                    // Draw image positioned and scaled
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val imgLeft = (viewportPx - displayedWidth) / 2f + clampedOffset.x
                        val imgTop = (viewportPx - displayedHeight) / 2f + clampedOffset.y

                        // Draw the bitmap
                        drawImage(
                            image = imageBitmap,
                            dstOffset = IntOffset(imgLeft.roundToInt(), imgTop.roundToInt()),
                            dstSize = IntSize(displayedWidth.roundToInt(), displayedHeight.roundToInt())
                        )

                        // Mask: darken outside the circle
                        val circleRadius = viewportPx / 2f
                        val center = Offset(viewportPx / 2f, viewportPx / 2f)

                        with(drawContext.canvas.nativeCanvas) {
                            val checkPoint = saveLayer(null, null)
                            // Dim entire surface
                            drawColor(android.graphics.Color.parseColor("#99000000"))
                            // Cut transparent circle in center
                            val clearPaint = android.graphics.Paint().apply {
                                xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.CLEAR)
                                isAntiAlias = true
                            }
                            drawCircle(center.x, center.y, circleRadius, clearPaint)
                            restoreToCount(checkPoint)
                        }

                        // Circular blue border
                        drawCircle(
                            color = Color(0xFF4E75FF),
                            radius = circleRadius - 1f,
                            center = center,
                            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Zoom controls
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = Icons.Default.ZoomOut,
                        contentDescription = "Menos zoom",
                        tint = Color(0xFF8E95A5),
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Slider(
                        value = zoom,
                        onValueChange = { newZoom ->
                            zoom = newZoom
                            val newScale = baseScale * newZoom
                            val newDispW = bitmap.width * newScale
                            val newDispH = bitmap.height * newScale
                            val newMaxX = max(0f, (newDispW - viewportPx) / 2f)
                            val newMaxY = max(0f, (newDispH - viewportPx) / 2f)
                            offset = Offset(
                                x = offset.x.coerceIn(-newMaxX, newMaxX),
                                y = offset.y.coerceIn(-newMaxY, newMaxY)
                            )
                        },
                        valueRange = 1f..4f,
                        colors = SliderDefaults.colors(
                            thumbColor = Color(0xFF4E75FF),
                            activeTrackColor = Color(0xFF4E75FF),
                            inactiveTrackColor = Color(0xFF222630)
                        ),
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Icon(
                        imageVector = Icons.Default.ZoomIn,
                        contentDescription = "Mais zoom",
                        tint = Color(0xFF4E75FF),
                        modifier = Modifier.size(20.dp)
                    )
                }

                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage!!,
                        color = Color(0xFFFF6B6B),
                        fontSize = 12.sp
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    isSaving = true
                    errorMessage = null
                    scope.launch {
                        try {
                            val imgLeft = (viewportPx - displayedWidth) / 2f + clampedOffset.x
                            val imgTop = (viewportPx - displayedHeight) / 2f + clampedOffset.y

                            val cropSizeInBitmap = (viewportPx / totalScale).coerceAtMost(minDim)
                            val cropLeft = ((-imgLeft) / totalScale).coerceIn(0f, bitmap.width - cropSizeInBitmap)
                            val cropTop = ((-imgTop) / totalScale).coerceIn(0f, bitmap.height - cropSizeInBitmap)

                            val cropped = Bitmap.createBitmap(
                                bitmap,
                                cropLeft.roundToInt(),
                                cropTop.roundToInt(),
                                cropSizeInBitmap.roundToInt(),
                                cropSizeInBitmap.roundToInt()
                            )

                            val targetSize = 512.coerceAtMost(cropped.width)
                            val finalBmp = if (cropped.width > targetSize) {
                                Bitmap.createScaledBitmap(cropped, targetSize, targetSize, true)
                            } else cropped

                            val baos = ByteArrayOutputStream()
                            finalBmp.compress(Bitmap.CompressFormat.JPEG, 85, baos)
                            var bytes = baos.toByteArray()
                            if (bytes.size > 256 * 1024) {
                                baos.reset()
                                finalBmp.compress(Bitmap.CompressFormat.JPEG, 60, baos)
                                bytes = baos.toByteArray()
                            }

                            val err = onSave(bytes)
                            if (err != null) {
                                errorMessage = err
                                isSaving = false
                            }
                        } catch (e: Exception) {
                            errorMessage = e.message ?: "Erro ao processar recorte."
                            isSaving = false
                        }
                    }
                },
                enabled = !isSaving,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E5BFF)),
                shape = RoundedCornerShape(8.dp)
            ) {
                if (isSaving) {
                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text("Confirmar Recorte", color = Color.White)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !isSaving) {
                Text("Cancelar", color = Color(0xFF8E95A5))
            }
        }
    )
}
