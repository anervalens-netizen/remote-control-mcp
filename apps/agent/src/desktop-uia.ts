export const uiaScript = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
# The .NET Framework proxy loader walks caller types; a PowerShell dynamic
# frame has no ReflectedType. A non-inlined managed frame initializes it reliably.
if(-not $script:RcmcpUiaProvidersLoaded){
  if(-not ("RcmcpUiaInit" -as [type])){
    Add-Type -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @'
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Automation;
public static class RcmcpUiaInit {
  [MethodImpl(MethodImplOptions.NoInlining)]
  public static void Initialize() {
    var name = typeof(AutomationElement).Assembly.GetName();
    name.Name = "UIAutomationClientsideProviders";
    ClientSettings.RegisterClientSideProviderAssembly(name);
  }
}
'@
  }
  [RcmcpUiaInit]::Initialize()
  $script:RcmcpUiaProvidersLoaded=$true
}
$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json
if(-not $script:RcmcpUiaElements){$script:RcmcpUiaElements=@{}}
$processIdentities=@{}
$desktopRoot=[System.Windows.Automation.AutomationElement]::RootElement
$desktopRuntime=$desktopRoot.GetRuntimeId() -join ','
function Process-Identity([int]$processId) {
  if($processId -eq 0){return '0'}
  if(-not $processIdentities.ContainsKey($processId)){
    try{$processIdentities[$processId]=[string]([Diagnostics.Process]::GetProcessById($processId).StartTime.ToUniversalTime().Ticks)}
    catch{throw 'Stale UI element: owning process exited; query the current tree again'}
  }
  return $processIdentities[$processId]
}
function Save-Element($element) {
  $runtime=$element.GetRuntimeId() -join ','
  if($runtime -eq $desktopRuntime){return 'uia-root:'+$runtime}
  $processId=$element.Current.ProcessId
  $anchor=$element
  while($anchor -and $anchor.Current.NativeWindowHandle -eq 0){
    $anchor=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($anchor)
  }
  $anchorHandle=if($anchor){$anchor.Current.NativeWindowHandle}else{0}
  $key='uia1:'+$processId+':'+(Process-Identity $processId)+':'+$anchorHandle+':'+$runtime
  $script:RcmcpUiaElements[$key]=@{element=$element;seen=[DateTime]::UtcNow}
  return $key
}
# Cache references only for navigation between calls. UI providers may invalidate
# elements at any moment; errors tell the caller to query the current tree again.
$expired=@($script:RcmcpUiaElements.Keys | Where-Object {([DateTime]::UtcNow-$script:RcmcpUiaElements[$_].seen).TotalMinutes -gt 10})
foreach($key in $expired){$script:RcmcpUiaElements.Remove($key)}
function Describe-Element($element,$details=$false) {
  $current=$element.Current
  $rect=$current.BoundingRectangle
  $patterns=@($element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName.Replace('PatternIdentifiers.Pattern','')})
  $out=[ordered]@{elementId=(Save-Element $element);runtimeId=@($element.GetRuntimeId());handle=$current.NativeWindowHandle;pid=$current.ProcessId;name=$current.Name;automationId=$current.AutomationId;controlType=$current.ControlType.ProgrammaticName.Replace('ControlType.','');className=$current.ClassName;enabled=$current.IsEnabled;offscreen=$current.IsOffscreen;focusable=$current.IsKeyboardFocusable;focused=$current.HasKeyboardFocus;password=$current.IsPassword;patterns=$patterns;rect=@{x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height}}
  if($details){
    $available=@()
    foreach($p in $element.GetSupportedPatterns()){
      $instance=$element.GetCurrentPattern($p)
      $methods=@($instance.GetType().GetMethods([Reflection.BindingFlags]'Public,Instance,DeclaredOnly') | Where-Object {-not $_.IsSpecialName} | ForEach-Object {
        @{name=$_.Name;parameters=@($_.GetParameters() | ForEach-Object {@{name=$_.Name;type=$_.ParameterType.FullName;out=$_.IsOut}})}
      })
      $state=@{}
      if($instance.PSObject.Properties['Current']){foreach($property in $instance.Current.PSObject.Properties){
        try{$v=$property.Value;if($null -eq $v -or $v -is [string] -or $v -is [bool] -or $v -is [int] -or $v -is [double]){$state[$property.Name]=$v}elseif($v.GetType().IsEnum){$state[$property.Name]=[string]$v}}catch{}
      }}
      $available+=@{name=$p.ProgrammaticName.Replace('PatternIdentifiers.Pattern','');methods=$methods;state=$state}
    }
    $out.patternDetails=$available
    $valuePattern=$null
    if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$valuePattern)){
      $out.value=$valuePattern.Current.Value;$out.readOnly=$valuePattern.Current.IsReadOnly
    }
    $textPattern=$null
    if($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$textPattern)){
      $textLimit=if($null -ne $i.textLimit){[int]$i.textLimit}else{2048}
      $out.text=$textPattern.DocumentRange.GetText($textLimit)
      $out.textLimit=$textLimit
    }
  }
  return [pscustomobject]$out
}
function Resolve-Element([string]$elementId) {
  if($elementId.StartsWith('uia-root:')){
    if($elementId -ne ('uia-root:'+$desktopRuntime)){throw 'Stale UI desktop root; query the current tree again'}
    return $desktopRoot
  }
  $parts=$elementId.Split(':')
  if($parts.Length -ne 5 -or $parts[0] -ne 'uia1'){throw 'Invalid UI element reference; query the current tree again'}
  $processId=[int]$parts[1]
  if((Process-Identity $processId) -ne $parts[2]){throw 'Stale UI element: owning process changed; query the current tree again'}
  $cached=$script:RcmcpUiaElements[$elementId]
  if($cached){return $cached.element}
  $runtime=[int[]]$parts[4].Split(',')
  if([int64]$parts[3] -eq 0){
    $element=[System.Windows.Automation.AutomationElement]::RootElement
    if($element.Current.ProcessId -ne $processId -or ($element.GetRuntimeId() -join ',') -ne $parts[4]){throw 'Stale UI desktop root; query the current tree again'}
    return $element
  }
  $anchor=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$parts[3])
  if(-not $anchor -or $anchor.Current.ProcessId -ne $processId){throw 'Stale UI element anchor; query the current tree again'}
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::RuntimeIdProperty,$runtime)
  $element=$anchor.FindFirst([System.Windows.Automation.TreeScope]::Subtree,$condition)
  if(-not $element -or $element.Current.ProcessId -ne $processId){throw 'Stale UI element unavailable; query the current tree again'}
  return $element
}
function Convert-Argument($value,[type]$type) {
  if($type.IsByRef){$type=$type.GetElementType()}
  if($null -eq $value){
    if($type.IsValueType){return [Activator]::CreateInstance($type)}
    return $null
  }
  if($type.IsInstanceOfType($value)){return ,$value}
  if($type.IsArray){
    $items=@($value);$array=[Array]::CreateInstance($type.GetElementType(),$items.Count)
    for($n=0;$n -lt $items.Count;$n++){$array.SetValue((Convert-Argument $items[$n] $type.GetElementType()),$n)}
    return ,$array
  }
  if($type -eq [System.Windows.Automation.AutomationElement]){
    $id=if($value -is [string]){$value}else{$value.elementId}
    if(-not $id){throw 'AutomationElement argument requires an elementId'}
    return Resolve-Element ([string]$id)
  }
  if($type -eq [System.Windows.Automation.AutomationProperty]){
    $name=if($value -is [string] -or $value -is [ValueType]){[string]$value}elseif($null -ne $value.id){[string]$value.id}else{[string]$value.name}
    $numeric=0
    if([int]::TryParse($name,[ref]$numeric)){
      $property=[System.Windows.Automation.AutomationProperty]::LookupById($numeric)
      if($property){return $property}
      throw ('UIA property ID is not registered: '+$name)
    }
    if(-not $script:RcmcpUiaPropertyNames){
      $script:RcmcpUiaPropertyNames=@{}
      $assemblies=@([System.Windows.Automation.AutomationElement].Assembly,[System.Windows.Automation.AutomationProperty].Assembly)|Select-Object -Unique
      foreach($assembly in $assemblies){foreach($owner in $assembly.GetExportedTypes()){
        foreach($field in $owner.GetFields([Reflection.BindingFlags]'Public,Static,FlattenHierarchy')){
          if($field.FieldType -eq [System.Windows.Automation.AutomationProperty]){
            $property=$field.GetValue($null)
            if($property){
              $script:RcmcpUiaPropertyNames[$property.ProgrammaticName]=$property
              $script:RcmcpUiaPropertyNames[$owner.Name+'.'+$field.Name]=$property
              if($owner -eq [System.Windows.Automation.AutomationElement]){
                $script:RcmcpUiaPropertyNames[$field.Name]=$property
                $script:RcmcpUiaPropertyNames[$field.Name -replace 'Property$','']=$property
              }
            }
          }
        }
      }}
    }
    $property=$script:RcmcpUiaPropertyNames[$name]
    if(-not $property){throw ('Unknown UIA property: '+$name+'; use its numeric ID or qualified property name')}
    return $property
  }
  if($type -eq [System.Windows.Point] -or $type -eq [System.Windows.Rect]){
    foreach($property in @('x','y')){if($null -eq $value.$property){throw ('Structured argument requires '+$property)}}
    if($type -eq [System.Windows.Point]){return [System.Windows.Point]::new([double]$value.x,[double]$value.y)}
    foreach($property in @('width','height')){if($null -eq $value.$property){throw ('Rect argument requires '+$property)}}
    return [System.Windows.Rect]::new([double]$value.x,[double]$value.y,[double]$value.width,[double]$value.height)
  }
  if($type.IsEnum){return [Enum]::Parse($type,[string]$value,$true)}
  return [System.Management.Automation.LanguagePrimitives]::ConvertTo($value,$type,[Globalization.CultureInfo]::InvariantCulture)
}
function Serialize-Result($value) {
  if($null -eq $value){return $null}
  if($value -is [System.Windows.Automation.AutomationElement]){return @{elementId=(Save-Element $value)}}
  if($value -is [System.Windows.Automation.Text.TextPatternRange]){
    $textLimit=if($null -ne $i.textLimit){[int]$i.textLimit}else{2048}
    return @{type='TextPatternRange';text=$value.GetText($textLimit);textLimit=$textLimit;boundingRectangles=@($value.GetBoundingRectangles());enclosingElementId=(Save-Element $value.GetEnclosingElement())}
  }
  if($value -is [Array]){
    $items=[Collections.Generic.List[object]]::new()
    foreach($item in $value){$items.Add((Serialize-Result $item))}
    return ,$items.ToArray()
  }
  if($value.GetType().IsEnum){return [string]$value}
  if($value -is [string] -or $value -is [ValueType]){return $value}
  return [string]$value
}
if($i.elementId){
  $root=Resolve-Element ([string]$i.elementId)
}elseif($i.handle){
  $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$i.handle)
}else{
  $root=[System.Windows.Automation.AutomationElement]::RootElement
}
if(-not $root){throw 'UI element unavailable; query desktop_windows and retry with its handle'}
$action=if($i.action){[string]$i.action}else{'query'}
if($action -eq 'query'){
  $depth=if($null -ne $i.depth){[int]$i.depth}else{3}
  $offset=if($null -ne $i.offset){[int]$i.offset}else{0}
  $limit=if($null -ne $i.limit){[int]$i.limit}else{100}
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack=[Collections.Generic.Stack[object]]::new()
  $stack.Push(@{element=$root;depth=0;parentId=$null})
  $found=[Collections.Generic.List[object]]::new()
  $errors=[Collections.Generic.List[object]]::new()
  $matched=0;$more=$false
  while($stack.Count -gt 0){
    $node=$stack.Pop()
    try{
      $value=Describe-Element $node.element
      $match=($null -eq $i.name -or $value.name.IndexOf([string]$i.name,[StringComparison]::OrdinalIgnoreCase) -ge 0) -and
        ($null -eq $i.automationId -or $value.automationId -eq [string]$i.automationId) -and
        ($null -eq $i.controlType -or $value.controlType -eq [string]$i.controlType)
      if($match){
        if($matched -ge $offset){
          if($found.Count -ge $limit){$more=$true;break}
          $value | Add-Member -NotePropertyName depth -NotePropertyValue $node.depth
          $value | Add-Member -NotePropertyName parentId -NotePropertyValue $node.parentId
          $found.Add($value)
        }
        $matched++
      }
      if($node.depth -lt $depth){
        $children=[Collections.Generic.List[object]]::new()
        $child=$walker.GetFirstChild($node.element)
        while($child){$children.Add($child);$child=$walker.GetNextSibling($child)}
        for($n=$children.Count-1;$n -ge 0;$n--){$stack.Push(@{element=$children[$n];depth=$node.depth+1;parentId=$value.elementId})}
      }
    }catch{$errors.Add(@{depth=$node.depth;message=$_.Exception.Message})}
  }
  [pscustomobject]@{elements=@($found.ToArray());offset=$offset;nextOffset=$(if($more){$offset+$found.Count}else{$null});depth=$depth;partial=($errors.Count -gt 0);errors=@($errors.ToArray())}|ConvertTo-Json -Compress -Depth 12
}elseif($action -eq 'inspect'){
  [pscustomobject]@{element=(Describe-Element $root $true)}|ConvertTo-Json -Compress -Depth 12
}else{
  $key=Save-Element $root
  $patternName=$null;$methodName=$null;$arguments=@()
  switch($action){
    'focus' {$root.SetFocus()}
    'invoke' {$patternName='Invoke';$methodName='Invoke'}
    'setValue' {$patternName='Value';$methodName='SetValue';$arguments=@([string]$i.value)}
    'select' {$patternName='SelectionItem';$methodName='Select'}
    'toggle' {$patternName='Toggle';$methodName='Toggle'}
    'expand' {$patternName='ExpandCollapse';$methodName='Expand'}
    'collapse' {$patternName='ExpandCollapse';$methodName='Collapse'}
    'pattern' {$patternName=[string]$i.pattern;$methodName=[string]$i.method;$arguments=@($i.arguments)}
    default {throw ('Unsupported UI action: '+$action)}
  }
  $result=$null;$outArguments=@{}
  if($patternName){
    $p=$root.GetSupportedPatterns() | Where-Object {$_.ProgrammaticName.Replace('PatternIdentifiers.Pattern','') -eq $patternName} | Select-Object -First 1
    if(-not $p){throw ('Element does not currently support '+$patternName+'; inspect its available patterns')}
    $instance=$root.GetCurrentPattern($p)
    $methods=@($instance.GetType().GetMethods([Reflection.BindingFlags]'Public,Instance') | Where-Object {$_.Name -eq $methodName -and $_.GetParameters().Length -eq $arguments.Count})
    if(-not $methods.Count){throw ('Pattern method/argument count not found: '+$patternName+'.'+$methodName)}
    $invoked=$false;$bindingError=$null
    foreach($method in $methods){
      $parameters=$method.GetParameters();$converted=[object[]]::new($arguments.Count)
      try{
        for($n=0;$n -lt $arguments.Count;$n++){
          $converted[$n]=Convert-Argument $arguments[$n] $parameters[$n].ParameterType
        }
      }catch{$bindingError=$_.Exception.Message;continue}
      $raw=$method.Invoke($instance,$converted);$invoked=$true
      $result=Serialize-Result $raw
      for($n=0;$n -lt $parameters.Length;$n++){if($parameters[$n].ParameterType.IsByRef){$outArguments[$parameters[$n].Name]=Serialize-Result $converted[$n]}}
      break
    }
    if(-not $invoked){throw ('Cannot bind pattern arguments: '+$bindingError)}
  }
  [pscustomobject]@{ok=$true;elementId=$key;action=$action;pattern=$patternName;method=$methodName;result=$result;outArguments=$outArguments}|ConvertTo-Json -Compress -Depth 12
}
`;
