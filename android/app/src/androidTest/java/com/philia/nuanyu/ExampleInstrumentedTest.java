package com.philia.nuanyu;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 设备上的冒烟测试：确认装起来的确实是暖屿这个包。
 *
 * 模板原本断言的是 com.getcapacitor.app（Capacitor 的示例包名），
 * 与暖屿的 applicationId 不符 —— 那样这条测试永远是红的。
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.philia.nuanyu", appContext.getPackageName());
    }
}
