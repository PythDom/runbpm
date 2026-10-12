package io.github.pythdom.runbpm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RunSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
